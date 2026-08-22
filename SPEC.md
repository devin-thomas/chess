# Orthodox Chess Rules Engine Specification

Status: ready-for-agent  
Specification version: 1.0  
Ruleset identifier: `orthodox-chess-v1`  
Modes: `basic`, `all-rules-enabled`  
Normative rules source: [FIDE Laws of Chess taking effect from 1 January 2023](https://handbook.fide.com/chapter/e012023)  

This is a language-agnostic specification for the rules engine and command-line boundary of a standard, non-variant chess game. The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative requirements.

This directory is standalone and has no existing repository or remote issue tracker. The local Markdown artifact is therefore the publication target; the `ready-for-agent` status above is the local equivalent of the requested triage label.

## Problem Statement

A command-line chess program needs more than a list of how pieces move. A correct game implementation must retain historical state, distinguish attacked squares from legal moves, apply multi-piece and multi-square moves atomically, and adjudicate outcomes that arise from claims, repetition, move counters, resignation, or time.

Without a precise, language-independent contract, independent implementations will disagree about cases such as:

- A pinned piece attacking a king's destination square.
- A king crossing an attacked square while castling.
- En passant exposing a rook or bishop attack on the moving king.
- Castling rights remaining lost after a king or rook returns home.
- An en-passant target that exists in the notation but cannot be legally captured.
- Underpromotion delivering check or checkmate.
- Threefold repetition being claimable while fivefold repetition is automatic.
- A 50-move claim being prospective while the 75-move rule is automatic.
- Checkmate taking precedence over the 75-move draw on the same move.
- A resignation or timeout being a draw when the opponent cannot possibly checkmate.

The user needs a specification that makes these decisions explicit and gives an implementer a deterministic state machine, command contract, and conformance test plan.

## Solution

Build one orthodox chess rules engine around a complete game state and an atomic state-transition operation. The engine MUST expose two fixed profiles:

1. `basic` provides the complete core board game: standard movement, captures, king safety, castling, en passant, promotion, check, checkmate, stalemate, and dead-position adjudication. It omits history-dependent claims and competitive session actions.
2. `all-rules-enabled` includes everything in `basic`, plus repetition history, threefold claims, fivefold automatic draws, 50-move claims, 75-move automatic draws, draw offers and agreements, resignation, and optional clock/timeout handling.

The engine MUST accept canonical coordinate moves and return machine-readable results. A human-readable shell command layer MAY map onto the same operations, but it MUST NOT define a second rules implementation.

The engine MUST keep board updates, historical counters, special-move state, and terminal adjudication in one atomic transition. An invalid unclocked command MUST leave the complete observable game state unchanged; timed-play clock accounting and competitive false-claim penalties are the explicit session-action exceptions defined below.

## User Stories

1. As a player, I want to start a new standard chess game, so that the board begins in the orthodox initial position.
2. As a player, I want White to move first, so that turn order matches standard chess.
3. As a player, I want the program to alternate turns, so that a player cannot move twice in succession.
4. As a player, I want every square to have an unambiguous coordinate from `a1` through `h8`, so that moves do not depend on display orientation.
5. As a player, I want the program to display the board and side to move, so that I can understand the current position.
6. As a player, I want the program to represent piece color and type separately, so that promoted pieces and captures are unambiguous.
7. As a player, I want bishops to move along unobstructed diagonals, so that their movement follows chess rules.
8. As a player, I want rooks to move along unobstructed ranks and files, so that their movement follows chess rules.
9. As a player, I want queens to move along unobstructed ranks, files, and diagonals, so that their movement follows chess rules.
10. As a player, I want knights to jump over intervening pieces, so that knight movement is not incorrectly treated like sliding movement.
11. As a player, I want kings to move one square at a time, so that ordinary king movement is legal only when the destination is safe.
12. As a player, I want pawns to advance only into empty squares, so that forward pawn movement cannot capture.
13. As a player, I want pawns to capture diagonally, so that pawn captures differ from pawn advances.
14. As a player, I want a pawn to make its initial two-square advance only from its starting rank and only across empty squares, so that blocked or late double advances are rejected.
15. As a player, I want captures to remove the opponent's piece atomically, so that no intermediate board can be observed.
16. As a player, I want a move onto a friendly piece to be rejected, so that pieces cannot overlap.
17. As a player, I want the program to distinguish an attacked square from a legal move, so that pinned pieces still protect and attack squares correctly.
18. As a player, I want the program to reject any move that leaves my own king in check, so that illegal self-checking moves cannot enter the game history.
19. As a player, I want double-check positions to allow only legal king evasions, so that multiple simultaneous attacks are handled correctly.
20. As a player, I want a king to be unable to move next to the opposing king, so that adjacent kings are never treated as legal.
21. As a player, I want the program to report check separately from game termination, so that a checked side with legal responses is not incorrectly checkmated.
22. As a player, I want checkmate to end the game immediately with the checking side as winner, so that no move can follow a mate.
23. As a player, I want stalemate to end the game as a draw when the side to move has no legal move but is not in check, so that stalemate is not reported as checkmate.
24. As a player, I want dead positions to be drawn when neither side can possibly checkmate by any legal continuation, so that the game cannot continue after an objective dead position.
25. As a player, I want castling to move the king and rook as one move, so that both kingside and queenside castling have the correct resulting board.
26. As a player, I want castling to require unmoved historical rights, present king and rook, empty path squares, and safe king origin, transit, and destination squares, so that castling edge cases are correct.
27. As a player, I want castling rights to remain lost after a king or rook moves away and returns, so that rights are not inferred from the current board alone.
28. As a player, I want the program to allow a rook to be attacked while still allowing castling when all king-path conditions are met, so that the rook's safety is not incorrectly required.
29. As a player, I want en passant to be available only on the immediately following ply after an opposing two-square pawn advance, so that stale en-passant opportunities expire.
30. As a player, I want en passant to remove the captured pawn from its passed-over square, so that the special capture changes the board correctly.
31. As a player, I want en passant to be rejected when its complete board mutation exposes my king, so that discovered self-check is not missed.
32. As a player, I want a pawn reaching the final rank to promote immediately, so that no unpromoted pawn can remain on the back rank.
33. As a player, I want to choose a queen, rook, bishop, or knight for promotion, including an underpromotion, so that the full promotion choice is available.
34. As a player, I want promotion effects to apply before check, mate, and draw adjudication, so that a promoted piece can give checkmate or affect the result on the same move.
35. As a player using `basic`, I want all core legal chess moves and core terminal positions, so that the basic profile remains a valid playable chess game.
36. As a player using `basic`, I want repetition claims, draw offers, resignation, and clocks to be unavailable explicitly, so that omitted features are not silently approximated.
37. As a tournament-oriented player using `all-rules-enabled`, I want the complete move history retained, so that repetition and prospective claims can be verified.
38. As a player, I want to claim a draw after a third occurrence of the same position, so that the threefold-repetition rule is available.
39. As a player, I want to claim a draw by naming a legal move that would create the third occurrence, so that prospective claims are supported.
40. As a player, I want castling rights, side to move, and legally usable en-passant rights to affect position identity, so that visually similar positions are not conflated.
41. As a player, I want fivefold repetition to end the game automatically, so that no claim is required for the automatic rule.
42. As a player, I want to claim a draw after 50 moves by each side without a pawn move or capture, so that the 50-move rule is available.
43. As a player, I want to make a prospective 50-move claim before the intended quiet move, so that the exact FIDE claim procedure is representable.
44. As a player, I want the 75-move rule to end the game automatically after 150 qualifying plies, so that the automatic threshold is enforced.
45. As a player, I want checkmate on the move reaching the 75-move threshold to take precedence, so that a winning mate is not incorrectly changed into a draw.
46. As a player, I want to offer a draw after a legal move and accept or reject an outstanding offer, so that draw agreements are represented as explicit actions.
47. As a player, I want an opponent's next move to reject an outstanding draw offer, so that the command-line protocol has a deterministic equivalent to declining by touching a piece.
48. As a player, I want to resign, so that a deliberate concession ends the game without requiring a legal move.
49. As a player, I want resignation to produce a draw when the opponent cannot possibly checkmate, so that the exceptional FIDE outcome is preserved.
50. As a player, I want optional clocks and timeout events in `all-rules-enabled`, so that a timed game can distinguish a win on time from a draw when no mate is possible.
51. As a player, I want an invalid move to return a stable error and leave the game unchanged, so that I can correct input safely.
52. As an integrator, I want a stable machine-readable command and response contract, so that any programming language can drive the engine.
53. As an integrator, I want canonical state serialization, so that a game can be saved, restored, replayed, and compared across implementations.
54. As an integrator, I want deterministic move ordering and error precedence, so that test suites and clients behave consistently.
55. As an implementer, I want black-box conformance vectors for every special move and terminal rule, so that independent implementations can be validated without sharing internal code.
56. As an implementer, I want a perft-style legal-move oracle, so that ordinary move generation can be checked against known counts.
57. As an implementer, I want variant rules explicitly excluded, so that orthodox castling and standard promotion are not confused with Chess960 or other variants.

## Implementation Decisions

### 1. Normative scope and terminology

- The ruleset is orthodox standard chess, not Chess960 and not any other variant.
- The specification is based on the English FIDE Laws of Chess approved for application from 1 January 2023. The source covers over-the-board chess and includes both Basic Rules of Play and Competitive Rules of Play.
- `Color` is `white` or `black`.
- `PieceType` is `king`, `queen`, `rook`, `bishop`, `knight`, or `pawn`.
- A `ply` is one turn by one side. A full move consists of one White ply and one Black ply. `fullmove_number` increments after Black's ply only.
- A `move` means a committed legal ply. A rejected request is not a move and MUST NOT change history or counters.
- An `attack` is defined by piece movement geometry and occupancy, without checking whether the attacking piece is pinned or whether moving it would expose its own king. A `legal move` is an allowed move that also leaves the moving side's king unattacked.
- A `check` exists when the side-to-move king is attacked.
- `Checkmate` means the side-to-move king is attacked and the side has no legal move.
- `Stalemate` means the side to move is not in check and has no legal move.
- A `dead position` means neither player can checkmate the opponent's king by any series of legal moves. This is the normative concept; an engine MUST NOT substitute a material-value heuristic and call it dead position.
- A `capture` includes ordinary captures, en-passant captures, and capture-promotions.
- A `terminal` game has a result and accepts no further game action other than read-only inspection.

### 2. Mode contract

The selected mode is fixed when a game state is created and is part of the serialized game state. `restore` installs the snapshot's complete state, including its declared mode; it MUST NOT reinterpret a snapshot under the caller's previous mode. A mode MUST NOT silently alter ordinary legal-move geometry.

| Capability | `basic` | `all-rules-enabled` |
| --- | --- | --- |
| Orthodox board, pieces, turns, and captures | MUST | MUST |
| Check, king safety, checkmate, stalemate | MUST | MUST |
| Castling | MUST | MUST |
| En passant | MUST | MUST |
| Promotion and underpromotion | MUST | MUST |
| Exact dead-position adjudication | MUST | MUST |
| Halfmove and fullmove counters | MUST retain and expose | MUST retain and expose |
| Repetition history | MAY omit after the current position | MUST retain |
| Threefold claim | Disabled with a stable error | MUST support |
| Fivefold automatic draw | Disabled | MUST support |
| 50-move claim | Disabled | MUST support |
| 75-move automatic draw | Disabled | MUST support |
| Draw offer and agreement | Disabled | MUST support |
| Resignation | Disabled | MUST support |
| Clock and timeout adapter | Disabled | MAY be configured; required for timed games |
| FIDE physical touch-move and arbiter behavior | Not represented | Not represented by the core CLI |

`basic` is the core board-game profile, not a profile that removes special chess moves. `all-rules-enabled` is the complete deterministic game-state profile. FIDE event administration contains human and arbiter decisions that cannot be inferred from a coordinate command stream; those boundaries are explicit below.

### 3. Board, coordinates, and orientation

- The board is an 8 by 8 grid of exactly 64 squares.
- Files are `a` through `h`; ranks are `1` through `8`.
- Coordinates increase from White's perspective: White pawns move toward increasing ranks and Black pawns move toward decreasing ranks.
- Display orientation MUST NOT affect coordinate meaning.
- The initial arrangement is:
  - White: rook `a1`, knight `b1`, bishop `c1`, queen `d1`, king `e1`, bishop `f1`, knight `g1`, rook `h1`; pawns `a2` through `h2`.
  - Black: rook `a8`, knight `b8`, bishop `c8`, queen `d8`, king `e8`, bishop `f8`, knight `g8`, rook `h8`; pawns `a7` through `h7`.
  - White is to move.
  - Castling rights are `KQkq`; en-passant target is absent; halfmove clock is `0`; fullmove number is `1`.
- `a1` is a dark square and `h1` is the near-right light square in the standard physical orientation. Square color is derived from coordinates and is not mutable game state.

### 4. Complete game-state model

The engine MUST model the following concepts, regardless of the implementation language or data structure:

`Position`:

- `board`: 64 cells, each empty or containing one colored piece.
- `side_to_move`: `white` or `black`.
- `castling_rights`: four independent rights: White king-side, White queen-side, Black king-side, Black queen-side.
- `en_passant_target`: either absent or the square passed over by the immediately preceding two-square pawn advance.
- `halfmove_clock`: number of consecutive plies since the most recent pawn move or capture.
- `fullmove_number`: positive move number, starting at 1.

`GameState`:

- `schema_version`.
- `mode`.
- `root_position`, the exact position at move-ledger ply `0`, including setup metadata when the game was created from a fixture or FEN-like input. For `new` without setup input this is the orthodox initial position.
- the current `Position`.
- the current status: `active` or `terminal`.
- check information: the checked color, or absent.
- terminal result: winner or draw reason, or absent.
- `terminal_event`, which is `null` while active and is a canonical record of the event that ended a terminal game.
- `repetition_history` containing position keys, including the initial position, in `all-rules-enabled`.
- a mandatory move ledger for every committed ply. Each record MUST contain a one-based `ply`, `actor`, canonical coordinate `move`, derived `kind`, and the resulting `position_key`; the ledger is not part of position identity, but it is required for replay and draw-agreement eligibility.
- derived `claimable_draws`, an array containing zero or more of `threefold` and `fifty_move` on an active all-rules state.
- an optional pending draw offer in `all-rules-enabled`, represented as `null` or an object containing `offered_by` and the `after_ply` at which it was created.
- optional clock state in `all-rules-enabled` when a time-control profile is supplied.
- a monotonically increasing `revision` for optimistic command concurrency. Queries and `save` do not increment it; each successful game mutation increments it exactly once. A timed invalid `play` that consumes elapsed time and a competitive false-claim clock penalty are explicit clock-only mutations and also increment it once. `new` initializes revision to `0`, and `restore` preserves the snapshot revision as a session-installation exception.

`Move` is identified by `from_square`, `to_square`, and an optional `promotion_piece`. The move kind is derived metadata and MAY be one of `normal`, `capture`, `castle`, `en_passant`, `promotion`, or `capture_promotion`. Castling is encoded as the king's origin and destination: `e1g1`, `e1c1`, `e8g8`, or `e8c8`.

`PositionKey` contains:

- Piece type and color on every square.
- Side to move.
- Castling rights.
- The effective en-passant opportunity: include the target only when the side to move has at least one legal en-passant capture; otherwise use absent.

The position key MUST NOT contain the halfmove clock, fullmove number, notation, timestamps, pending draw offers, clock values, or prior occurrence counts.

State invariants MUST include: when `repetition_history` is present, its last key equals the current position key; the move ledger contains exactly one record per committed ply and, when non-empty, its first actor matches the root position's side to move; `after_ply` on a pending draw offer identifies an existing ledger boundary; `claimable_draws` equals the claims recomputed from the current state; an active state has no outcome or terminal event; a terminal state has both an outcome and a terminal event, no pending offer, and no move after the event; and a `basic` state has no pending offer, clock, or claim action state.

`terminal_event` MUST contain an event `kind` from `move_adjudication`, `draw_agreement`, `claim`, `resignation`, or `timeout`, plus the ledger boundary `after_ply`. A move-adjudication event records the derived reason such as `checkmate`, `stalemate`, `dead_position`, `fivefold_repetition`, or `seventy_five_move`. A `draw_agreement` event records `offered_by` and `accepted_by`; a `claim` event records the claiming `actor`, `reason`, and a nullable `prospective_move`; a `resignation` event records the resigning `actor`; and a `timeout` event records the timed-out color and `clock_event_sequence`. Every event MUST include the data needed to reproduce and validate the outcome. Terminal event data is historical state, not position identity.

### 5. Position creation and restoration

- `new` MUST create the standard initial position when no setup input is supplied. If a fixture or FEN-like setup is supplied, it becomes the root position and is immediately validated and adjudicated.
- A canonical engine snapshot MUST preserve the complete state, including root position, revision, repetition history, mode, counters, move ledger, terminal event, derived claimability, pending offer, and any clock state.
- `new` and `perft` MUST accept a language-neutral canonical setup record using the `Position` fields above; `new` installs it as the root position and `perft` uses it only as a read-only root. A setup record MAY carry `fixture_validation: authoritative` or `fixture_validation: non_authoritative`; authoritative is the default. The canonical setup record is the required fixture seam even when FEN parsing is not implemented.
- A FEN-like position interchange MAY be provided as an alias for fixtures and analysis. If provided, it MUST preserve all six FEN fields: piece placement, side to move, castling rights, en-passant target, halfmove clock, and fullmove number.
- Loading a FEN-like position without move history initializes the supplied position as the first known occurrence. It MUST NOT claim to reconstruct earlier repetitions.
- FEN-like input is a setup boundary, not proof that the position was historically reachable from the initial position. A strict tournament game MUST be restored from a canonical snapshot or a replay from the initial position.
- In a history-less FEN setup, a pawn on its original rank is treated as eligible for its two-square move under the setup convention. A caller needing a different historical fact MUST use a canonical replay/snapshot or an explicit fixture metadata field; the engine MUST NOT claim that a bare FEN reconstructs per-pawn history.
- A setup position MUST be rejected if it does not have exactly one king per side, if the kings are adjacent, if any pawn is on rank 1 or rank 8, if multiple pieces occupy one square, or if the coordinates or castling/en-passant metadata are malformed or incompatible.
- An authoritative position validator MUST reject both kings being in check or the side not to move being in check, because such a position cannot result from a legal completed move. A fixture mode MAY allow such positions only when it marks the setup as non-authoritative.
- Castling rights are trusted historical state in a canonical snapshot. They MUST NOT be regenerated merely from current king and rook placement.
- For strict FEN metadata, an en-passant target MUST be on rank 6 when White is to move or rank 3 when Black is to move, MUST be empty, and MUST have the opposing pawn on the square immediately behind the target (`target - one rank` for White to move, `target + one rank` for Black to move). The absence of an adjacent capturer does not by itself invalidate the raw target; it only makes the effective repetition-key target absent.
- A canonical `restore` MUST validate the snapshot rather than trust its derived fields. It MUST replay the root position through the move ledger, recompute every resulting position key and counter, and compare the final position, repetition history, check, legal moves, terminal status, claimability, outcome, and terminal event. Board-derived terminal events MUST be recomputed. Action-derived events MUST be validated against the final active position, ledger boundary, offer/claim/clock data, and, for resignation or timeout, the exact possible-mate predicate. Any mismatch is `E_INVALID_SNAPSHOT`. The snapshot's non-negative `revision` is preserved exactly; restoring is session installation rather than a game ply and therefore does not increment revision. If `expected_revision` is supplied for an in-session restore, it MUST match the pre-restore session revision.

### 6. Command and response contract

The normative machine interface is a JSON Lines stream: one UTF-8 request object produces one UTF-8 response object. A process MAY additionally expose shell-friendly commands, but they MUST map to the same state-transition functions.

Supported operations are:

| Operation | Required behavior |
| --- | --- |
| `new` | Create a game with `mode` and optional clock profile. |
| `state` | Return the complete externally observable current state. |
| `legal_moves` | Return all legal moves for the side to move in canonical coordinate form. |
| `play` | Validate and commit one legal move. An optional `offer_draw` flag may be attached to the completed move in `all-rules-enabled`. |
| `offer_draw` | Create an unconditional pending draw offer in `all-rules-enabled`. |
| `claim_draw` | Claim `threefold` or `fifty_move`, optionally with a prospective legal move. Only the side to move may claim. |
| `accept_draw` | Accept an outstanding draw offer. |
| `reject_draw` | Reject and clear an outstanding draw offer. |
| `resign` | Resign the actor's side in `all-rules-enabled`. |
| `clock_event` | Supply a deterministic clock/flag event when a clock profile is enabled. |
| `save` | Return a canonical snapshot without changing state. |
| `restore` | Install a validated canonical snapshot as the current session state. |
| `perft` | Return a read-only legal-move-tree count for conformance testing. |

Every response MUST include:

- the request identifier if one was supplied;
- `ok: true` or `ok: false`;
- the current `revision`;
- on success, the requested result and relevant state/status fields;
- on failure, a stable error code and enough structured context to identify the rejected operation.

The request fields are:

| Operation | Required fields | Optional fields |
| --- | --- | --- |
| `new` | `operation`, `mode` | `clock_profile`, canonical `setup` record or FEN-like setup input |
| `state` | `operation` | `expected_revision` for a consistent read |
| `legal_moves` | `operation` | move/output format, `expected_revision` |
| `play` | `operation`, `actor`, `move` | `expected_revision`, `offer_draw`, `elapsed_ms`, `expected_clock_sequence` (the last two are required when a clock is enabled) |
| `offer_draw` | `operation`, `actor` | `expected_revision` |
| `claim_draw` | `operation`, `actor`, `reason` | `prospective_move`, `expected_revision` |
| `accept_draw` | `operation`, `actor` | `expected_revision` |
| `reject_draw` | `operation`, `actor` | `expected_revision` |
| `resign` | `operation`, `actor` | `expected_revision` |
| `clock_event` | `operation`, event type, affected color, event sequence | elapsed time or flag, `expected_revision` |
| `save` | `operation` | `expected_revision` |
| `restore` | `operation`, canonical snapshot | `expected_revision` |
| `perft` | `operation`, non-negative depth | canonical `setup` record or FEN-like fixture position, `expected_revision` |

`actor` MUST be `white` or `black`. `play` and `claim_draw` require `actor` to equal `side_to_move`. `offer_draw`, `accept_draw`, `reject_draw`, and `resign` require an active-game actor and enforce the pending-offer or resignation rules above. A client that does not authenticate actors MAY run a local two-player session, but it MUST still validate the declared color.

The canonical response state MUST use these field types: `revision` is a non-negative integer; `mode` is one of the two mode identifiers; `root_position` is a canonical position/setup record; `board` is an array of exactly 64 cells in `a1` through `h8` order where each cell is `null` or a `{color, type}` object; `side_to_move` is a color; `castling_rights` is a four-boolean object; `en_passant_target` is a square or `null`; counters are non-negative integers; `status` is `active` or `terminal`; `check` is a color or `null`; `outcome` is `null` or `{reason, result, winner, at_ply}` with a declared reason, a result score, a nullable winner, and the terminal ledger boundary; `terminal_event` is `null` or the event record defined above; `move_ledger` is an ordered array of the move records defined above; `repetition_history` is an ordered key array when the mode retains it; `claimable_draws` is an array of the declared claim reasons and is empty in a terminal state; `pending_draw_offer` is `null` or `{offered_by, after_ply}`; and `clock` is `null` or the clock object defined below. A terminal event's `after_ply` and the outcome's `at_ply` MUST equal the current move-ledger length.

An error response MUST contain an `error` object with mandatory `code` and `operation` fields and optional `field`, `move`, `actor`, and `details` fields. A successful `save` response MUST contain the canonical snapshot, including the current `revision`; `save` does not increment revision. A successful `restore` response MUST contain the restored state.

The machine contract MUST use canonical coordinate input. The canonical move text is four lowercase coordinate characters, such as `e2e4`, with one lowercase promotion suffix `q`, `r`, `b`, or `n` when required, such as `e7e8q`. The parser MUST reject malformed casing, off-board coordinates, missing promotion selectors, and unsupported extra syntax rather than guessing.

The human CLI MAY provide aliases such as `O-O`, SAN, or interactive board rendering, but those are presentation conveniences. They MUST be parsed into the canonical `Move` before validation and MUST NOT change legality.

`perft` is defined independently of game-session adjudication: depth `0` returns `1`; for depth greater than `0`, recursively count fully legal moves from the supplied position, stopping only when no legal move exists; a depth-greater-than-zero node with no legal moves contributes zero descendants. It ignores dead-position, repetition, 50-move, 75-move, draw-offer, resignation, and clock terminal conditions so that it remains a move-generation oracle. The request MUST use the current position unless an explicit fixture position is supplied, and the response MUST include the requested depth, the root position identity, and the node count. A separate result-aware tree traversal MAY be implemented, but it is not `perft` and MUST have a distinct operation or option name.

### 7. Piece movement and captures

- A bishop may move to any unobstructed square on a diagonal.
- A rook may move to any unobstructed square on its rank or file.
- A queen may move to any unobstructed square on a rank, file, or diagonal.
- A knight moves by a two-plus-one offset and jumps over intervening pieces.
- A king moves to one adjacent square, subject to king-safety validation.
- A piece MUST NOT move onto a square occupied by a friendly piece.
- A normal capture removes exactly one opposing piece from the destination as part of the same move.
- A move that would capture a king MUST be rejected. The game ends at checkmate; kings are never captured.
- Sliding pieces MUST NOT jump over any intervening piece, including a piece of the moving side.
- Off-board destination coordinates are invalid and MUST NOT wrap around files or ranks.

Pawns:

- White advances toward increasing ranks; Black advances toward decreasing ranks.
- A one-square advance requires an empty destination.
- A two-square advance requires the pawn to be on its original rank, both the intermediate and destination squares to be empty, and the move to be that pawn's first advance in a valid game.
- A diagonal pawn move is legal only when it captures an opposing piece, is a legal en-passant capture, or reaches a valid capture-promotion target.
- A pawn MUST NOT capture forward.
- A pawn MUST NOT remain on the final rank after a committed move.

### 8. Attacks, checks, and king safety

The engine MUST have an attack calculation independent from legal-move generation. `is_attacked(square, by_color)` evaluates raw piece attacks using the movement rules and current occupancy.

- A pinned piece still attacks squares for king movement, castling-path, and check purposes. Do not implement attack as "the piece has a legal move."
- A pawn attacks its two forward diagonals regardless of whether an opposing piece currently occupies the target.
- A king attacks every adjacent square, which prevents kings from becoming adjacent.
- A slider's attack stops at the first occupied square; the occupied square itself may be attacked, but squares beyond it are not.
- A side is in check when its king square is attacked by the opponent under these rules.
- A candidate move is legal only if the moving side's king is present and not attacked after all move effects are applied.
- A move may block a check, capture a checking piece, or move the king, but it MUST remove every check.
- A double-check position naturally permits only king moves after full legal filtering; the implementation MUST NOT special-case a non-king response that leaves one checker active.
- A king capture is legal only when the destination is not attacked in the resulting board after the captured piece is removed.

The legal-move algorithm SHOULD be:

1. Generate movement candidates for the side to move.
2. Add castling, en-passant, and all valid promotion choices.
3. Apply each candidate to an isolated temporary position, including every capture and piece replacement.
4. Reject candidates that leave the moving side's king attacked.
5. Apply special preconditions such as castling-path attacks and exact en-passant availability.
6. Return the remaining moves in deterministic order.

### 9. Castling

Castling is one king move and one rook move. The standard destinations are:

| Move | King | Rook |
| --- | --- | --- |
| White king-side | `e1` to `g1` | `h1` to `f1` |
| White queen-side | `e1` to `c1` | `a1` to `d1` |
| Black king-side | `e8` to `g8` | `h8` to `f8` |
| Black queen-side | `e8` to `c8` | `a8` to `d8` |

Castling is legal only when all of the following hold:

- The corresponding castling right is present.
- The king is on its original square and the selected rook is on its original square.
- The king and selected rook have not previously moved, as represented by the right.
- Every square between the king and selected rook is empty. For queen-side castling this includes the rook-side square `b1` or `b8`.
- The king is not currently in check.
- The king's origin, transit, and destination squares are not attacked by the opponent.
- No enemy piece is captured by castling; an occupied path square always makes castling illegal.

The rook's path squares do not need to be unattacked. An attacked rook does not by itself prevent castling. An enemy piece counts as attacking a king-path square even if that enemy piece is pinned to its own king.

For deterministic attack evaluation, test the king-path squares as follows: test the origin on the current board; for the transit square, clear the king's origin and place the king on the transit square while leaving the rook at its original square; for the destination, clear the origin and place the king on the destination while still leaving the rook at its original square. In both temporary boards, all other pieces remain unchanged and raw attack semantics apply. Then apply the complete king-and-rook castle and run ordinary post-move king-safety validation. This prevents a later rook placement from incorrectly making a transit square appear safe.

Castling rights are removed permanently:

- when the relevant king moves;
- when the relevant original rook moves from its original square; or
- when the relevant original rook is captured on its original square.

Moving a king or rook back does not restore a right. A promoted rook never creates a castling right.

### 10. En passant

- After a pawn makes a legal two-square advance, set the en-passant target to the square it passed over.
- The target exists for exactly the opponent's next ply and expires if unused.
- A legal en-passant capture requires an opposing pawn adjacent on the correct rank, the exact current target square, an empty target square, and the captured pawn on the square immediately behind the target.
- The capturing pawn moves diagonally to the target and the captured pawn is removed from its original square.
- En passant is a capture and resets the halfmove clock.
- The entire resulting position, including removal of the captured pawn, MUST pass king-safety validation. This catches horizontal and diagonal discovered checks.
- A stale, malformed, or non-capturable target MUST NOT produce a legal move.
- Only the immediately following ply may use the target. A later move cannot use it even if the target square remains empty.

### 11. Promotion

- A pawn arriving on rank 8 for White or rank 1 for Black MUST be replaced as part of that same move.
- The promotion choice MUST be exactly one of queen, rook, bishop, or knight of the pawn's color.
- The choice is not limited by pieces previously captured.
- A forward promotion requires an empty destination; a capture-promotion requires an opposing piece on the diagonal destination; en-passant and promotion do not combine.
- An omitted, invalid, king, or pawn promotion choice MUST be rejected by the canonical command interface.
- The promoted piece takes effect immediately for attack, check, checkmate, stalemate, dead-position, repetition, and counter adjudication.
- Every legal promotion creates up to four distinct legal moves, even when the resulting pieces look materially similar.
- Promotion resets the halfmove clock because it is a pawn move. Capture-promotion resets it for both reasons.

### 12. Applying a legal move

The engine MUST validate first and commit second for an unclocked move. A successful move transition MUST perform these steps atomically:

1. Confirm the game is active and the request revision, if supplied, matches.
2. Confirm the requester is the side to move.
3. Resolve the canonical move to exactly one legal move.
4. Move the piece, remove any ordinary or en-passant capture, and replace any promoted pawn.
5. Move the rook when castling.
6. Update castling rights permanently according to moved kings, moved rooks, and captured original rooks.
7. Set the new en-passant target only after a two-square pawn advance; otherwise clear it.
8. Reset the halfmove clock after any pawn move or capture; otherwise increment it by one.
9. Increment the fullmove number after Black's ply only.
10. Toggle the side to move.
11. Append the move record and new position key to repetition history in `all-rules-enabled`.
12. Clear any existing pending draw offer before processing the move.
13. Compute check, legal moves, terminal status, and the corresponding move-adjudication event.
14. If the request attached `offer_draw` and the resulting state is active, create a new offer at the new ledger boundary. A terminal state has no offer.
15. Commit the new state and increment revision exactly once.

If any board validation or adjudication step fails, the original board, rights, target, counters, history, ledger, pending offer, status, and revision MUST remain unchanged. A timed `play` has a defined clock prefix exception below.

### 13. Terminal states and precedence

The engine MUST adjudicate after every accepted move and immediately after restoring a state. Claimability is reported on active states but does not itself terminate the game.

For deterministic result reasons, use this order after a legal move:

1. Checkmate: the move gave check and the new side to move has no legal move.
2. Stalemate: the new side to move is not in check and has no legal move.
3. Dead position: neither side can possibly checkmate by any legal continuation.
4. Fivefold repetition in `all-rules-enabled`.
5. Seventy-five-move automatic draw in `all-rules-enabled`.
6. Otherwise the game remains active, with any available threefold or 50-move claims exposed.

All outcomes in steps 2 through 5 are draws even if more than one draw condition is true. The precedence only chooses the reported reason. Checkmate MUST take precedence over an automatic 75-move draw on the same move, as required by FIDE Article 9.6.2. The same precedence is used for fivefold repetition so that a move that immediately checkmates cannot be reclassified as a draw.

Terminal outcome values MUST distinguish at least:

- `checkmate` with winner color;
- `stalemate`;
- `dead_position`;
- `fivefold_repetition`;
- `seventy_five_move`;
- `draw_agreement`;
- `threefold_claim`;
- `fifty_move_claim`;
- `resignation` with winner or draw exception;
- `timeout` with winner or draw exception.

The result score is `1-0` for a White win, `0-1` for a Black win, and `1/2-1/2` for a draw.

### 14. Dead-position adjudication

Dead position is a rules requirement in both modes. The engine MUST provide an exact adjudication service, tablebase authority, or equivalent proof mechanism for every position it claims to support. It MUST NOT declare dead position merely because:

- material is low;
- an evaluation function reports a draw;
- a forced mate search did not find a mate within a depth limit; or
- a common "insufficient material" whitelist matched.

King versus king, king and bishop versus king, and king and knight versus king are required obvious fixtures, but they are not the complete definition. The implementation MUST document the authority and limitations of its dead-position solver. If exact adjudication is unavailable for a claimed position class, the implementation MUST not label its profile `all-rules-enabled` for that class.

A conforming implementation MUST bind a deterministic `dead_position_oracle` to the ruleset before a game can be created. The oracle MUST return a definitive `dead` or `not_dead` result for every accepted position; an `unknown` result is not a valid terminal status. If the oracle is external, its name and version MUST be included in the implementation conformance record and, when necessary for reproducible snapshots, in the snapshot metadata. This makes the hard adjudication dependency explicit instead of leaving independent implementations with silently different material heuristics.

The same exact "can a mate possibly occur?" predicate is used for the resignation and timeout exceptions.

### 15. Repetition and position identity

- The initial position counts as the first occurrence.
- Only committed legal moves append to history. Rejected requests and non-move queries do not.
- Threefold repetition is claimable, not automatic. The side to move may claim when the current position key has occurred at least three times.
- A prospective threefold claim may name a legal move. The engine simulates the move, computes the resulting key, and accepts the claim if the key would have appeared at least three times. The intended move is not committed after a correct claim.
- Fivefold repetition is automatic when a position key has appeared at least five times.
- Position identity includes side to move, piece placement, castling rights, and effective legally usable en-passant availability.
- Position identity excludes halfmove and fullmove counters, move notation, timestamps, clock values, pending draw offers, and the history count itself.
- A raw en-passant target that cannot be used by any legal en-passant capture is treated as absent in the key. This avoids treating a non-move opportunity as a difference in possible moves.
- A castling right remains part of the key until removed. Returning a king or rook to its original square does not make the earlier position repeat if the right was lost.

### 16. 50-move and 75-move rules

- The halfmove clock resets to zero on every pawn move and every capture, including en passant and capture-promotion.
- Every other legal ply increments the clock by one, including castling, a checking move, and a checking move that does not capture.
- In `all-rules-enabled`, a 50-move claim is available when the clock is at least 100 plies, or when a named legal prospective move would make it at least 100 plies.
- A correct prospective claim ends the game without applying the intended move.
- A 50-move claim is not automatic; the game continues if no claim is made.
- In `all-rules-enabled`, a 75-move draw is automatic at a halfmove clock of at least 150, subject to checkmate precedence.
- A pawn move or capture after a 50-move claim opportunity resets the clock if the game has not ended for another reason.

### 17. Draw offers, agreements, and claims

Draw offers are `all-rules-enabled` actions:

- A draw offer is unconditional.
- `offer_draw` MAY be issued at any time during an active game where the event profile permits draw offers. A `play` request MAY attach an equivalent offer to the legal move just completed, representing the normal FIDE post-move/pre-clock procedure.
- A draw agreement is allowed only after both colors occur as actors in the committed move ledger. An offer made earlier remains pending but cannot yet be accepted; the opponent's next move rejects it.
- An offer remains pending until the opponent accepts, explicitly rejects, makes a move, or the game ends.
- Only the opponent of the offering side may accept the offer.
- Only the opponent of the offering side may explicitly reject the offer; the offering side cannot withdraw it through `reject_draw`.
- An accepted offer ends the game as `draw_agreement` and records a `terminal_event` containing `offered_by`, `accepted_by`, and the current `after_ply`.
- An offer made before both players have moved returns `E_DRAW_AGREEMENT_UNAVAILABLE` if acceptance is attempted. `accept_draw` with no pending offer returns `E_NO_PENDING_DRAW_OFFER`.
- A new offer is unavailable while another offer is pending and returns `E_DRAW_OFFER_UNAVAILABLE`.
- Any committed move clears an existing pending offer before the move is processed. If that same `play` request attaches `offer_draw` and the resulting state is active, a new offer is created by the mover at the new ledger boundary.
- A draw offer is not part of position identity or repetition history.

Draw claims:

- Only the side to move may claim threefold or 50-move draws.
- A claim operation MUST identify its reason and MAY identify a prospective legal move.
- A correct claim ends the game immediately, records a `terminal_event` containing the claiming actor and reason, and does not apply a prospective move.
- An incorrect current-position claim returns a stable `E_CLAIM_UNAVAILABLE` error and leaves board state unchanged. Under an explicit competitive FIDE clock profile, the opponent receives two minutes added to the opponent's remaining time; that clock-only penalty is a documented action mutation even though the board claim failed.
- An incorrect prospective claim returns `E_CLAIM_UNAVAILABLE` with the validated intended move in `details`. In a no-clock CLI the board and revision remain unchanged and the caller may submit that move normally. A competitive FIDE adapter MUST retain the intended legal move as a required next move, add the prescribed two-minute penalty to the opponent, and serialize that adapter restriction; any other move is rejected until the intended move is completed. This is the explicit boundary for Article 9.5.3; the core CLI does not model physical touch-move.
- A claim cannot be made after a terminal state.

### 18. Resignation

In `all-rules-enabled`, `resign` is an explicit action by a color. It immediately ends an active game. The resigning player loses if the opponent can possibly checkmate that player's king by some legal sequence. If no such sequence exists, the result is a draw. A resignation is not a move and does not change board counters or repetition history before the result is recorded.
The action records a `terminal_event` containing the resigning actor, the current ledger boundary, and the computed winner or draw exception, and increments revision exactly once. In a clocked session, the caller MUST submit any elapsed-time `clock_event` before resignation; the core does not infer wall time during a non-move action.

### 19. Optional clocks and timeout handling

The core board transition is deterministic and does not read wall-clock time. `all-rules-enabled` MAY attach a clock component supplied by a time-control adapter. A clock profile MUST define:

- initial time for each color;
- whether time is measured as main time, delay, increment, or a documented combination;
- the monotonic time source or explicit elapsed-time events;
- when a move is considered completed;
- how a flag event is ordered relative to a move event.

The normative single-period clock object contains `time_mode` (`main`, `increment`, or `delay`), `main_time_ms` per color, `remaining_ms` per color, the applicable `increment_ms` or `delay_ms`, `running_color`, and a strictly increasing `event_sequence`. No clock is represented by `clock: null`; an enabled clock uses one of the three time modes. The clock starts with `running_color` equal to `side_to_move` and `remaining_ms` equal to `main_time_ms`.

For a main-time profile, elapsed time `e` changes `remaining_ms` to `max(0, remaining_ms - e)` with no post-move amount. For an increment profile, elapsed time `e` first changes `remaining_ms` to `max(0, remaining_ms - e)` and a legal non-terminal move then adds `increment_ms` to the mover's remaining time. For a delay profile, the charged time is `max(0, e - delay_ms)` and no post-move amount is added. A profile MUST NOT provide both increment and delay unless it defines a separate deterministic combination rule. All time values are integer milliseconds and MUST be non-negative.

A `play` request with an enabled clock MUST include the elapsed milliseconds since the previous clock switch and the expected event sequence. The engine deducts that elapsed time from the running color before validating the move; if it reaches zero first, a timeout result is committed and the move is not applied. If the move is legal and non-terminal, the increment is added or the delay is resolved, the running color switches, and the event sequence advances.

The timed `play` prefix is an explicit exception to ordinary invalid-command atomicity. After request, revision, active-game, actor, turn, and clock-field validation succeeds, the elapsed-time event is applied. If time remains but the board move is malformed or illegal, the board, side, rights, counters, move ledger, repetition history, and pending offer remain unchanged, while the clock and event sequence remain advanced and revision increments once; the response is `ok: false` with the move error and current state. This models a player having spent time on an illegal attempt without treating that attempt as a move. If the elapsed event flags the player, the timeout terminal result takes precedence and the move is not validated or applied.

`clock_event` MUST contain an event type (`elapsed` or `flag_fall`), the running affected color, an event sequence greater than the current sequence, and either a non-negative elapsed duration or an explicit flag. A non-flag event that leaves time above zero advances the clock and revision without changing the board. A flag event ends the active game as `timeout`, records the event sequence in `terminal_event`, and clears any pending offer. An adapter that uses wall-clock timestamps MUST convert them to this ordered monotonic event stream before calling the core. The canonical snapshot includes the clock object and sequence so restoration cannot reorder time events.

The core result rule is normative:

- A player whose time expires loses unless the opponent cannot possibly checkmate that player's king, in which case the result is a draw.
- A legal move that ends the game is complete when its game-ending position is reached; it is not converted into a timeout merely because a separate clock-press action would have followed it.
- A timeout event after a terminal result is rejected with `E_GAME_OVER`; it MUST NOT replace the existing result.
- Clock state and time events are never part of position identity.

Non-move actions such as `offer_draw`, `claim_draw`, `accept_draw`, `reject_draw`, and `resign` do not infer elapsed wall time. A clocked caller MUST submit an ordered `clock_event` first when it needs to advance the clock; if that event flags the player, the timeout result is final before the action is processed.

Detailed late-arrival, default-time, simultaneous-flag, rapid, blitz, quickplay, and arbiter-observation procedures require event regulations. They MAY be implemented by an adapter, but the adapter MUST translate them into an ordered game action or timeout event rather than modifying the board directly.

### 20. Illegal input and error behavior

Except for the timed-play and competitive-penalty exceptions defined above, invalid canonical requests MUST be rejected before any state mutation. The following error codes and precedence are normative:

- `E_INVALID_REQUEST`
- `E_UNKNOWN_OPERATION`
- `E_INVALID_REVISION`
- `E_GAME_OVER`
- `E_INVALID_POSITION`
- `E_INVALID_SNAPSHOT`
- `E_INVALID_MOVE_SYNTAX`
- `E_RULE_DISABLED`
- `E_WRONG_TURN`
- `E_EMPTY_SOURCE`
- `E_OWN_PIECE_ON_DESTINATION`
- `E_ILLEGAL_GEOMETRY`
- `E_PATH_BLOCKED`
- `E_SELF_CHECK`
- `E_INVALID_PROMOTION`
- `E_CASTLE_UNAVAILABLE`
- `E_CASTLE_THROUGH_CHECK`
- `E_EN_PASSANT_UNAVAILABLE`
- `E_CLAIM_UNAVAILABLE`
- `E_DRAW_OFFER_UNAVAILABLE`
- `E_NO_PENDING_DRAW_OFFER`
- `E_DRAW_AGREEMENT_UNAVAILABLE`
- `E_INVALID_TIME_CONTROL`
- `E_INVALID_CLOCK_EVENT`
- `E_CLOCK_SEQUENCE`
- `E_NO_CLOCK`

Messages MAY be human-oriented and localized; clients MUST rely on codes and structured fields rather than message text. For ordinary requests, validation MUST occur in this order:

1. Request encoding and envelope.
2. Operation and field validation.
3. Expected revision.
4. Active-game check for game actions (`play`, `offer_draw`, `claim_draw`, `accept_draw`, `reject_draw`, `resign`, and `clock_event`). A terminal game returns `E_GAME_OVER` before a feature-specific error. `new` and `restore` are session-installation operations and remain available after termination; `state`, `legal_moves`, `save`, and `perft` are read-only queries.
5. Move parsing.
6. Mode-specific feature availability. An otherwise active `basic` claim, offer, resignation, or clock operation returns `E_RULE_DISABLED`.
7. Actor and turn validation.
8. Piece, occupancy, geometry, special-move, and promotion validation.
9. King-safety validation.
10. State transition and outcome adjudication.

If a feature is enabled but its condition is false, use the feature-specific code such as `E_CLAIM_UNAVAILABLE`, `E_CASTLE_UNAVAILABLE`, or `E_DRAW_OFFER_UNAVAILABLE`; do not reuse `E_RULE_DISABLED`.

For a timed `play`, request shape, revision, active-game, actor, turn, and clock-field validation occur before the elapsed-time prefix. Coordinate parsing and board legality validation occur after that prefix so an illegal attempt can consume time as specified above. A missing or non-numeric move field is an envelope/field error and does not consume time.

The engine MUST NOT accept a coordinate that "captures" the opposing king. It MUST report checkmate instead. A normal CLI rejects an illegal move at submission; it does not simulate physical over-the-board piece displacement, two-handed moves, or a clock press after an illegal move.

### 21. Serialization and notation

Canonical snapshots MUST be language-neutral and contain enough data to restore an exact game. They MUST include:

- schema version;
- mode;
- root position and setup metadata;
- revision;
- board pieces and empty squares;
- side to move;
- castling rights;
- raw en-passant target;
- halfmove and fullmove counters;
- current status, check, and outcome;
- terminal event when the game is terminal;
- derived `claimable_draws`;
- repetition history in `all-rules-enabled`;
- the complete committed move ledger;
- pending draw offer and clock data when present.

Serialization MUST be deterministic: UTF-8, stable field names, stable ordering where the format allows ordering, and no implementation-specific fields in the canonical form.

FEN output SHOULD be supported for interoperability and fixtures. If FEN input is supported, the parser MUST distinguish a raw en-passant field from the effective repetition-key en-passant field; it MUST NOT erase a valid raw target merely because no capture is currently legal. FEN import cannot carry revision, move ledger, or repetition history, so it initializes those according to the setup rules above rather than pretending to be an exact snapshot.

SAN or algebraic notation MAY be emitted as presentation output. If emitted, it MUST derive from the committed legal move and resulting state:

- piece letters are `K`, `Q`, `R`, `B`, and `N`; pawns have no letter;
- captures may use `x`; pawn captures include the origin file;
- castling is `O-O` or `O-O-O`;
- promotion identifies the new piece;
- disambiguation is required when two identical pieces can legally reach the same square;
- `+` and `#` are derived check and mate indicators, not client-supplied facts.

The canonical command interface remains coordinate-based so that parsing notation is not required to implement rules.

### 22. Deterministic ordering and replay

- Legal moves MUST be returned in a deterministic order: origin squares from `a1` through `h8`, then destination squares from `a1` through `h8`, then promotion choices in the order queen, rook, bishop, knight.
- Equivalent requests MUST produce equivalent state and result output, apart from request identifiers and explicitly non-deterministic clock timestamps.
- A replay from the recorded root position using the committed move ledger MUST reproduce every position key, counter, right, terminal status, and result. If the root is the orthodox initial position, this is the ordinary replay-from-initial-position case.
- A replay of an action-derived terminal event MUST apply the recorded event after the final ledger boundary and MUST reproduce the same outcome without inventing a board move.
- Saving and restoring a canonical snapshot MUST preserve the same legal moves and adjudication state.
- Rejected commands MUST not enter the replay ledger.

### 23. Public rule seams

The implementation SHOULD organize behavior around language-independent seams, even if the final code uses different module boundaries:

- `parse_move` converts canonical input to a move request.
- `attacks_square` evaluates raw attacks.
- `in_check` evaluates king safety.
- `generate_legal_moves` returns legal moves for a position and mode.
- `apply_legal_move` applies one already validated move to a temporary position.
- `position_key` computes repetition identity.
- `adjudicate` computes active/terminal status and claimability.
- `execute` applies one command to one complete game state and returns a result.

The highest conformance seam is `execute`: tests should drive it with serialized input and inspect serialized output. The lower-level seams are useful for focused move-generation tests and perft diagnostics but should not duplicate state-transition policy.

## Testing Decisions

Tests MUST verify externally observable rules behavior, not a particular board array, object layout, programming language, or algorithm. A refactor that preserves the command contract and all resulting states MUST remain green.

There is no existing codebase or test prior art in the target directory. The proposed test prior art is therefore the standard black-box/table-driven pattern used by chess engines: legal-move conformance vectors, perft counts, state round trips, and property-based invariants.

### Primary test seam

Use one highest-level seam wherever possible:

- Start from a canonical initial state or a declared fixture position.
- Submit one or more machine commands to `execute`.
- Assert the response code, resulting state, counters, history keys, check status, claimability, terminal reason, and result.

Internal helpers MAY have focused tests, but tests MUST NOT require callers to invoke internal helpers to prove a public rule.

### Baseline legal-move and perft tests

From the orthodox initial position, legal move-tree counts MUST match:

| Depth | Nodes |
| ---: | ---: |
| 1 | 20 |
| 2 | 400 |
| 3 | 8,902 |
| 4 | 197,281 |
| 5 | 4,865,609 |

The test harness SHOULD also run perft positions focused on castling, en passant, promotions, and pinned pieces. Perft is a read-only legal-move diagnostic and MUST ignore history-dependent automatic draws. A separate result-aware game-tree traversal MAY stop on those conditions, but it MUST NOT be labeled or counted as perft.

### Movement and obstruction tests

Cover every piece from edges and corners, with empty paths, friendly blockers, enemy blockers, and off-board targets. At minimum:

- A knight jumps over pieces but cannot land on a friendly piece.
- A bishop, rook, or queen cannot jump; it may capture the first enemy piece on its path but cannot move beyond it.
- A pawn cannot advance into an occupied square or capture forward.
- A pawn double advance is legal only from rank 2 for White or rank 7 for Black, with both squares clear.
- Black pawn direction mirrors White pawn direction.
- Kings cannot become adjacent and cannot capture a defended piece.

### King safety and attack tests

Use positions with an absolute pin, a diagonal pin, a discovered check, double check, a checking slider, a checking knight, a checking pawn, and a checking king. Verify:

- A pinned piece is not a legal mover when moving would expose its king.
- The same pinned piece still attacks squares for opposing king movement.
- A move that blocks one checker but leaves another is rejected.
- A checking move is not mate if even one legal response exists.
- A side in check may only submit an evasion.
- A move that would capture a king is rejected and the opponent is instead reported as checkmated only when the position satisfies checkmate.

### Castling matrix

For each color and side, test:

- rights present and all conditions clear;
- right absent with pieces still on their home squares;
- king moved away and back;
- rook moved away and back;
- king or required rook missing;
- friendly or enemy piece on every path square;
- king currently in check;
- transit square attacked by each piece type;
- destination square attacked by each piece type;
- rook attacked while all king conditions are safe;
- queen-side rook-path square `b1` or `b8` attacked while `c` and `d` king-path squares are safe;
- resulting king and rook placement and lost rights.

Use this clear-path fixture for both colors:

`r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1`

Use this queen-side path fixture to prove that an attacked `b1` does not block White's castling when `c1` and `d1` are safe:

`1r2k3/8/8/8/8/8/8/R3K3 w Q - 0 1`

### En-passant matrix

Legal baseline:

`k7/8/8/3pP3/8/8/8/4K3 w - d6 0 1`, move `e5d6`.

Assert that the White pawn arrives on `d6`, the Black pawn on `d5` is removed, the halfmove clock resets, and the target expires after the next ply.

Exposing-check baseline:

`k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1`, move `e5d6`.

Assert that the move is rejected because removing the pawn from `e5` exposes the rook on `e8` against the White king on `e1`.

Also test a stale target, a missing captured pawn, a non-adjacent pawn, an occupied target, a diagonal discovered check, a Black en-passant capture, and en passant as the only legal check evasion. For a concrete forced-en-passant fixture, start from `8/7p/5K1k/8/7p/7P/5PP1/8 w - - 0 1`, play `g2g4`, and assert that Black's only legal move is `h4g3` en passant. The conformance corpus MUST include a replay-generated position in which en passant is the only legal check evasion; the invariant is that it is counted as a legal evasion only when the complete resulting board removes the check.

### Promotion matrix

Use `2k5/P7/8/8/8/8/8/4K3 w - - 0 1` and test all four moves `a7a8q`, `a7a8r`, `a7a8b`, and `a7a8n`. Assert that each resulting piece is exact and the halfmove clock resets.

Use `1r2k3/P7/8/8/8/8/8/4K3 w - - 37 1` and test `a7b8q`, `a7b8r`, `a7b8b`, and `a7b8n`. Assert that each move captures the rook and resets the halfmove clock. Reject promotion without a selector, to a king or pawn, onto a friendly piece, forward onto an enemy piece, or diagonally onto an empty square. Verify that promotion can give check and checkmate and that a promoted rook never grants castling rights.

### Checkmate, stalemate, dead position, and precedence

Checkmate fixture:

`7k/6Q1/5K2/8/8/8/8/8 b - - 0 1`

Stalemate fixture:

`7k/5K2/6Q1/8/8/8/8/8 b - - 0 1`

Dead-position fixture:

`7k/8/8/8/8/8/8/6K1 w - - 0 1`

Assert that checkmate, stalemate, and dead position produce distinct reasons. Add exact-dead tests for the implementation's declared adjudicator and tests proving that material evaluation alone is not accepted as a dead-position proof.

For automatic-draw precedence, use a position at halfmove clock `149` where a quiet move reaches `150` without mate, and a separate position where a legal quiet move reaches `150` and checkmates. The first MUST be `seventy_five_move`; the second MUST be `checkmate`.

A suitable mate boundary fixture is:

`7k/8/5KQ1/8/8/8/8/8 w - - 149 1`, move `g6g7`.

### Repetition tests

Use:

`4k3/8/8/8/8/8/8/R3K2N w - - 0 1`

and repeat the four-ply cycle `Nh1f2 Ke8d8 Nf2h1 Kd8e8`.

Assert that the initial key counts as occurrence one, the third occurrence is claimable in `all-rules-enabled`, and the fifth occurrence is automatically terminal. Assert that `basic` rejects the claim as disabled and otherwise continues the cycle.

Modify one state at a time to prove that position identity changes when side to move, piece placement, castling rights, or legally usable en-passant changes. Prove that halfmove and fullmove counters do not change identity. Move a rook out and back and verify that lost castling rights prevent a false repetition match.

### 50-move and 75-move tests

Use a legal quiet position with halfmove clock `99`, such as:

`4k3/8/8/8/8/8/R7/K7 w - - 99 1`.

Assert that a quiet move reaches `100`, that a 50-move claim is then available in `all-rules-enabled`, and that the same claim is disabled in `basic`. Test a prospective claim from `99` without committing the named move.

Use `4k3/8/8/8/8/8/R7/K7 w - - 149 1`, move `a2a3`, to verify a quiet move reaches `150` and produces an automatic 75-move draw. Use equivalent positions with clock `150` to verify an already-terminal automatic draw. Also test castling, non-capturing check, promotion, en passant, ordinary capture, capture-promotion, and rejected moves for their exact halfmove behavior.

### Draw actions, resignation, and clocks

Test draw offers after a legal move, acceptance by the opponent, rejection, implicit rejection by a move, premature agreement before both players have moved, and attempts to offer or accept after termination.

Test resignation by both colors, including a position where the opponent has no possible mating sequence and must therefore receive a draw rather than a win.

With a clock profile, test increment/delay update, a flag before a move, a legal game-ending move before the flag event, timeout when the opponent can mate, and timeout when the opponent cannot mate. Ensure clock state never enters repetition identity.

### Atomicity and serialization tests

For every invalid unclocked command, assert that board, side, rights, en-passant target, counters, history, move ledger, pending offer, clock, status, and revision are byte-for-byte unchanged. Also test the timed-play exception: an illegal timed move leaves all board/game fields unchanged but retains the consumed clock event and increments revision once. A valid game mutation increments revision once; a false claim with a competitive clock profile is tested as a clock-only penalty mutation.

Save and restore canonical snapshots after ordinary moves, castling, en passant, promotion, repetition cycles, pending draw offers, draw agreements, claims, resignation, timeout, and terminal board results. Replayed snapshots MUST produce the same legal moves and result. FEN round trips, if supported, MUST preserve all six FEN fields and distinguish raw en-passant state from effective repetition identity. Fixture-root snapshots MUST replay from their recorded root rather than assuming the orthodox initial board.

### CLI black-box tests

The CLI MUST have defined behavior for help, version, unknown operations, missing arguments, malformed move text, invalid positions, terminal games, invalid promotions, coordinate case, end-of-file, blank input, multiple commands, standard output versus standard error, and deterministic exit status. It MUST never print a stack trace or silently continue after corrupting state.

### Metamorphic and property tests

- Mirror a legal position vertically and swap colors; legality and outcomes should mirror.
- Applying a legal move then serializing and restoring it must preserve all observable state.
- Legal move generation must never produce a move leaving the mover's king attacked.
- A rejected move must not append history or change counters.
- Every generated promotion choice must differ only in the selected promoted piece and resulting derived status.
- A raw en-passant target with no legal capture must not change the position key.
- A state with the same board but different halfmove/fullmove counters must have the same position key.
- A state with different castling rights must not have the same position key, even when the board is identical.

## Out of Scope

- Chess960, Fischer Random, three-check, antichess, atomic chess, crazyhouse, and all other variants.
- Engine evaluation, best-move selection, search, opening books, tablebase move selection, or player ratings.
- A graphical interface, board art, animations, or accessibility presentation. The state and machine protocol remain accessible to any frontend.
- Physical over-the-board actions such as touch-move, j'adoube, one-hand requirements, two-handed castling, hand release, physical piece displacement, and pressing a physical clock.
- Arbiter discretion, venue conduct, mobile-device penalties, fair-play investigations, late arrival/default time, appeals, score-sheet ownership, and competition administration.
- Rapid, blitz, blind/visually disabled, adjourned-game, and quickplay-finish procedures unless a separately documented event adapter maps them to deterministic actions and clock events.
- Network latency, simultaneous client commands, server clock trust, and distributed event ordering. A caller using clocks MUST provide an authoritative ordered event stream.
- A claim that arbitrary FEN setup positions are historically reachable from the initial position. Strict tournament games use a replay or canonical snapshot with trusted history.
- Null moves, pass moves, takebacks, analysis-only illegal moves, and editing a terminal game.
- Material-value heuristics as a substitute for exact dead-position or possible-mate adjudication.
- A requirement that every implementation use a particular programming language, object model, board array layout, or search algorithm.

## Further Notes

### Normative references

- [FIDE Laws of Chess, effective 1 January 2023](https://handbook.fide.com/chapter/e012023) is the primary source for board rules, movement, castling, en passant, promotion, check, legal moves, completion, draw claims, automatic draws, clocks, and resignation.
- [FIDE Rules Commission FAQ](https://rcc.fide.com/frequently-asked-questions/) is useful for interpreting dead-position and insufficient-material edge cases. The specification uses the formal term `dead position` rather than treating "insufficient material" as a complete algorithm.
- [FIDE 2023 Laws PDF](https://rcc.fide.com/wp-content/uploads/2022/11/Laws_of_Chess-2023.pdf) is a stable printable copy of the same normative edition.

### Deliberate profile boundary

The FIDE Laws cover over-the-board play, so "all rules enabled" cannot mean that a command-line process infers a human's intention from physical touch or chooses an arbiter's discretionary penalty. This specification includes every deterministic board and game-outcome rule, exposes non-standard player actions as explicit commands, and defines the adapter boundary for clocks and event procedures. It does not hide those limitations behind a vague mode name.

### Hard implementation requirements

1. Preserve historical state. A board-only implementation cannot correctly implement castling, en passant, repetition, or the move counters.
2. Separate attacks from legal moves. A pinned piece can attack a square even when it cannot legally move there.
3. Apply special moves atomically. En passant and castling mutate more than one piece; promotion changes a piece's type before adjudication.
4. Make terminal precedence explicit. Checkmate, stalemate, dead position, automatic draws, claims, resignation, and timeout are not interchangeable status strings.
5. Treat dead position and "can possibly checkmate" as proof obligations, not evaluation guesses.
6. Keep the core transition pure or transactionally isolated so invalid commands cannot partially mutate state.

### Suggested implementation milestone order

1. Coordinate and piece model, initial position, ordinary legal moves, attacks, and king safety.
2. Castling, en passant, promotion, checkmate, stalemate, and dead position.
3. Canonical snapshots, deterministic responses, errors, and replay.
4. Full history, position keys, threefold/fivefold, and 50/75-move adjudication.
5. Draw offers, agreement, resignation, and exact result reporting.
6. Optional clock adapter, timeout exceptions, and event-profile integration.
7. Perft, conformance vectors, property tests, and independent replay verification.

### Open verification items for a tournament-certified implementation

- Re-check the chosen FIDE Laws edition before release and version the ruleset if the source changes.
- Document and independently verify the exact dead-position adjudicator for every supported position class.
- Confirm the effective-en-passant position-key policy against the selected FIDE interpretation and test pinned en-passant cases.
- Keep event-specific rapid, blitz, online, and arbiter rules in separate profiles rather than changing the orthodox core silently.
