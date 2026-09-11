# Shared replay fixtures

`../replay-cases.json` indexes canonical replay inputs and their separate expected
states. These authored examples have no third-party game attribution requirements.
Every successful ply is recorded, including root and end, so later conformance
harnesses can select any checkpoint without deriving expectations from the engine
under test. Invalid inputs record their valid prefix and first rejected move.

Run `npm run test:replay` from the repository root to verify TypeScript validation
and controller seeks against these committed expectations.

Expected states come from the independent `python/chess_cpu.py` implementation.
To intentionally regenerate them, run `python3 shared/replay-fixtures/generate.py`.
Review changes to the goldens before committing; normal tests never regenerate
them. The generator uses the all-rules-enabled mode and fresh root history.

The expected state preserves every observable engine state field, converts
castling rights to the replay wire format's four booleans, and adds the replay
revision (committed ply). `position_key` is the Python engine's effective
en-passant key; repetition maps are compared in full, including their keys.
No clocks, renderer identity, or presentation event counters are included.

Coverage includes both colors and sides of castling, en passant, all four
promotions, capture-promotion, Black-to-move roots with a fullmove offset,
checkmate, stalemate and dead-position roots, empty replay, draw claims and
automatic repetition/75-move termination, source-result disagreement, illegal
moves, and attempted moves after checkmate. Tests also assert special-move
occupancy explicitly and seek backward/forward through the history goldens.
