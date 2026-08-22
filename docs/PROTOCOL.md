# Chess CLI Protocol

This project implements the same public JSON Lines protocol in C, Python, TypeScript/Node, and Rust. One JSON object is read from standard input per line and one JSON object is written to standard output per line. Diagnostics go to standard error. A process remains alive and retains one session until EOF.

The protocol is intentionally smaller than a human chess notation interface. Moves use lowercase coordinate notation: `e2e4`, `e7e8q`, `e1g1`, or `e1c1`. Promotion suffixes are `q`, `r`, `b`, and `n`.

## Requests

Every request has an `op` field. Supported operations are:

| Operation | Required fields | Behavior |
| --- | --- | --- |
| `new` | `op` | Reset the session. Optional `mode` (`basic` or `all-rules-enabled`), `fen`, and `seed`. |
| `state` | `op` | Return the current observable state without changing it. |
| `legal_moves` | `op` | Return sorted fully legal moves for the side to move. |
| `play` | `op`, `move` | Apply one fully legal move atomically. |
| `perft` | `op`, `depth` | Count legal move-tree nodes from the current, optional `fen`, or initial position. |
| `run` | `op` | Start a fresh CPU-vs-CPU game. Optional `mode`, `fen`, `seed`, `max_plies`, and `trace`; `trace` defaults to `true` and controls whether `moves` is populated. |
| `sample` | `op`, `samples` | Sample uniformly from the root position's legal moves without changing state. Optional `fen` and `seed`; the initial position is used when neither a session nor `fen` is supplied. |

`new` defaults to `all-rules-enabled` and the orthodox initial position. `run` defaults to `all-rules-enabled`, seed `1`, and `max_plies` `600`. A run stops at a chess terminal result or at `max_plies`; the latter has termination `max_plies` and result `*`.

## Success responses

Every success response has `ok: true` and `op`. State-bearing operations include `state`. `legal_moves` includes `moves`; `perft` includes `depth` and `nodes`; `sample` includes `moves`, `counts`, `sequence`, `samples`, and `seed`; `run` includes `seed`, `moves`, `plies`, `termination`, `result`, and `final`.

For `sample`, `samples` is the requested integer count, `counts` maps each legal move to its observed frequency, and `sequence` contains the sampled move names in draw order. The sequence is provided for reproducible statistical analysis and does not change session state.

The state shape is:

```json
{
  "mode": "all-rules-enabled",
  "board": [null, {"color":"white","type":"king"}],
  "side_to_move": "white",
  "castling_rights": "KQkq",
  "en_passant_target": null,
  "halfmove_clock": 0,
  "fullmove_number": 1,
  "status": "active",
  "check": null,
  "outcome": null,
  "claimable_draws": [],
  "repetition_counts": {"<position-key>": 1},
  "moves": []
}
```

The board array is in `a1` through `h8` order. `check` is the checked color or `null`. `outcome` is `null` while active, otherwise it contains `reason`, `result`, and optional `winner`. `repetition_counts` is exposed in `all-rules-enabled` and may be empty in `basic`. `moves` is the committed UCI move ledger.

## Errors

Failures have `ok: false`, `op`, `error.code`, and the unchanged current `state` when a session exists. The implementations use these stable codes where applicable:

`E_INVALID_REQUEST`, `E_UNKNOWN_OPERATION`, `E_INVALID_FEN`, `E_GAME_OVER`, `E_INVALID_MOVE_SYNTAX`, `E_RULE_DISABLED`, `E_WRONG_TURN`, `E_EMPTY_SOURCE`, `E_OWN_PIECE_ON_DESTINATION`, `E_ILLEGAL_GEOMETRY`, `E_PATH_BLOCKED`, `E_SELF_CHECK`, `E_INVALID_PROMOTION`, `E_CASTLE_UNAVAILABLE`, `E_CASTLE_THROUGH_CHECK`, `E_EN_PASSANT_UNAVAILABLE`, `E_CLAIM_UNAVAILABLE`, and `E_NO_SESSION`.

Rejected moves never modify the board, counters, history, or result.

## Rules implemented

Both modes implement orthodox movement, captures, king safety, check, checkmate, stalemate, castling, en passant, and promotion. `basic` omits history-dependent draw rules. `all-rules-enabled` retains position history, exposes claimability as `"threefold_repetition"` and `"fifty_move"` (including a legal next move that would create the claim), and automatically adjudicates fivefold repetition and the 75-move rule. Dead-position detection includes the exact obvious dead classes required by the program and is conservative for other material.

## CPU and randomness

CPU players uniformly select one move from the sorted legal move list. All four implementations use the same SplitMix64 generator with unsigned 64-bit arithmetic:

```text
state = (state + 0x9E3779B97F4A7C15) mod 2^64
z = state
z = ((z xor (z >> 30)) * 0xBF58476D1CE4E5B9) mod 2^64
z = ((z xor (z >> 27)) * 0x94D049BB133111EB) mod 2^64
output = z xor (z >> 31)
```

The selected index is `output mod number_of_legal_moves`. Seeds are serialized as decimal strings in responses so the C, Python, JavaScript, and Rust numeric domains remain equivalent.
