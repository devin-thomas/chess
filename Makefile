CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Wpedantic
PYTHON ?= python3
NODE ?= node
RUSTC ?= rustc
ROOT := $(abspath .)
C_BIN := $(ROOT)/build/chess_c
TS_FILE := $(ROOT)/typescript/chess_cpu.ts
RUST_SOURCE := $(ROOT)/rust/chess_cpu.rs
RUST_BIN := $(ROOT)/build/chess_rust
NES_PROOF_ARGS ?=

.PHONY: build test benchmark benchmark-replay compile-replay conformance-replay conformance-replay-retro replay-nes-proof nes-build nes-proof nes-fceux nes-rom clean

build:
	mkdir -p build
	$(CC) $(CFLAGS) c/chess_cpu.c -o $(C_BIN)
	$(RUSTC) --edition=2021 -O $(RUST_SOURCE) -o $(RUST_BIN)
	$(NODE) --experimental-strip-types $(TS_FILE) </dev/null

test: build replay-nes-proof
	npm run typecheck
	npm run test:replay
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v
	$(PYTHON) tests/run_shared.py --python "$(PYTHON) python/chess_cpu.py" --c "$(C_BIN)" --typescript "$(NODE) --experimental-strip-types $(TS_FILE)" --rust "$(RUST_BIN)"
	$(PYTHON) tools/replay-conformance.py --python "$(PYTHON) python/chess_cpu.py" --c "$(C_BIN)" --typescript "$(NODE) --experimental-strip-types $(TS_FILE)" --rust "$(RUST_BIN)" --retro-output build/replay_nes_output.txt --output reports/replay-conformance.json

benchmark: build
	$(PYTHON) bench/benchmark.py --python "$(PYTHON) python/chess_cpu.py" --c "$(C_BIN)" --typescript "$(NODE) --experimental-strip-types $(TS_FILE)" --rust "$(RUST_BIN)" --output-dir reports

benchmark-replay:
	$(NODE) --experimental-strip-types tools/replay-cache-benchmark.ts --json-out reports/replay-cache-benchmark.json

compile-replay:
	mkdir -p build
	$(NODE) --experimental-strip-types tools/compile-replay.ts shared/replay-fixtures/opening.json build/opening.rply build/opening.rply.manifest.json

conformance-replay: build replay-nes-proof
	$(PYTHON) tools/replay-conformance.py --python "$(PYTHON) python/chess_cpu.py" --c "$(C_BIN)" --typescript "$(NODE) --experimental-strip-types $(TS_FILE)" --rust "$(RUST_BIN)" --retro-output build/replay_nes_output.txt --output reports/replay-conformance.json

conformance-replay-retro: build nes-proof
	$(PYTHON) tools/replay-conformance.py --python "$(PYTHON) python/chess_cpu.py" --c "$(C_BIN)" --typescript "$(NODE) --experimental-strip-types $(TS_FILE)" --rust "$(RUST_BIN)" --retro-output build/nes-replay-trace.json --output reports/replay-conformance-retro.json

replay-nes-proof:
	mkdir -p build
	$(NODE) --experimental-strip-types tools/emit-nes-embed.ts shared/replay-fixtures/castle-kingside.json build/nes_replay_data.h
	$(CC) $(CFLAGS) -I$(ROOT)/build retro/replay_nes.c retro/nes_replay.c -o $(ROOT)/build/replay_nes_proof
	$(ROOT)/build/replay_nes_proof > $(ROOT)/build/replay_nes_output.txt
	cat $(ROOT)/build/replay_nes_output.txt

nes-build:
	$(PYTHON) tools/nes-proof.py $(NES_PROOF_ARGS) --build-only

nes-proof:
	$(PYTHON) tools/nes-proof.py $(NES_PROOF_ARGS)

nes-fceux: nes-proof

nes-rom: nes-build

clean:
	rm -rf build reports
