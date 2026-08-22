CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Wpedantic
PYTHON ?= python3
NODE ?= node
ROOT := $(abspath .)
C_BIN := $(ROOT)/build/chess_c
TS_FILE := $(ROOT)/typescript/chess_cpu.ts

.PHONY: build test benchmark clean

build:
	mkdir -p build
	$(CC) $(CFLAGS) c/chess_cpu.c -o $(C_BIN)
	$(NODE) --experimental-strip-types $(TS_FILE) </dev/null

test: build
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v
	$(PYTHON) tests/run_shared.py --python "$(PYTHON) python/chess_cpu.py" --c "$(C_BIN)" --typescript "$(NODE) --experimental-strip-types $(TS_FILE)"

benchmark: build
	$(PYTHON) bench/benchmark.py --python "$(PYTHON) python/chess_cpu.py" --c "$(C_BIN)" --typescript "$(NODE) --experimental-strip-types $(TS_FILE)" --output-dir reports

clean:
	rm -rf build reports
