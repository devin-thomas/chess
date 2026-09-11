#!/usr/bin/env python3
"""Build the cc65 NES replay ROM and capture its deterministic FCEUX trace."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
FIXTURE = ROOT / "shared" / "replay-fixtures" / "castle-kingside.json"
EMBED_TOOL = ROOT / "tools" / "emit-nes-embed.ts"
ROM = BUILD / "nes_replay.nes"
MAP = BUILD / "nes_replay.map"
LUA = ROOT / "tools" / "nes_trace.lua"
TRACE = BUILD / "nes-replay-trace.json"


def fail(message: str) -> NoReturn:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def resolve_cc65_home(value: str | None) -> Path | None:
    candidate = value or os.environ.get("NES_CC65_HOME") or os.environ.get("CC65_HOME")
    return Path(candidate).expanduser() if candidate else None


def resolve_tool(name: str, home: Path | None) -> str:
    if home is not None:
        bundled = home / "bin" / name
        if bundled.is_file() and os.access(bundled, os.X_OK):
            return str(bundled)
    resolved = shutil.which(name)
    if resolved is None:
        fail(f"cannot find {name}; set NES_CC65_HOME or install cc65")
    return resolved


def run(command: list[str], *, env: dict[str, str] | None = None, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=True,
        )
    except FileNotFoundError as exc:
        fail(f"cannot execute {command[0]}: {exc}")
    except subprocess.CalledProcessError as exc:
        details = (exc.stdout + exc.stderr).strip()
        fail(f"command failed ({' '.join(command)}): {details}")
    except subprocess.TimeoutExpired as exc:
        details = ((exc.stdout or "") + (exc.stderr or "")).strip()
        fail(f"command timed out ({' '.join(command)}): {details}")


def build_rom(cc65_home: Path | None) -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    node = os.environ.get("NODE", "node")
    run([node, "--experimental-strip-types", str(EMBED_TOOL), str(FIXTURE), str(BUILD / "nes_replay_data.h")])
    cl65 = resolve_tool("cl65", cc65_home)
    environment = os.environ.copy()
    if cc65_home is not None:
        environment["CC65_HOME"] = str(cc65_home)
    result = run(
        [
            cl65,
            "-t",
            "nes",
            "-Oirs",
            "-I" + str(BUILD),
            "-I" + str(ROOT / "retro"),
            "-m",
            str(MAP),
            "-o",
            str(ROM),
            str(ROOT / "retro" / "nes_replay_main.c"),
            str(ROOT / "retro" / "nes_replay.c"),
        ],
        env=environment,
    )
    print(f"NES_BUILD ok rom={ROM.relative_to(ROOT)} bytes={ROM.stat().st_size}")
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)


def run_emulator(fceux: str) -> None:
    TRACE.unlink(missing_ok=True)
    command = [fceux, "--no-config", "1", "--sound", "0", "--loadlua", str(LUA), str(ROM)]
    environment = os.environ.copy()
    environment["NES_TRACE_OUTPUT"] = str(TRACE)
    try:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        fail(f"cannot execute FCEUX: {exc}")
    deadline = time.monotonic() + 30.0
    while process.poll() is None and not TRACE.is_file():
        if time.monotonic() >= deadline:
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=5.0)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            details = (stdout + stderr).strip()
            fail(f"FCEUX timed out: {details}")
        time.sleep(0.1)
    if TRACE.is_file():
        process_was_running = process.poll() is None
        if process_was_running:
            process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate()
        if not process_was_running and process.returncode != 0:
            details = (stdout + stderr).strip()
            fail(f"FCEUX failed after producing a trace: {details}")
    else:
        stdout, stderr = process.communicate()
        details = (stdout + stderr).strip()
        fail(f"FCEUX failed (exit {process.returncode}): {details}")
    try:
        report = json.loads(TRACE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"FCEUX produced invalid trace JSON: {exc}")
    records = report.get("records") if isinstance(report, dict) else None
    if (
        not isinstance(report, dict)
        or report.get("schema_version") != 1
        or report.get("profile") != "cc65-fceux"
        or not isinstance(records, list)
        or not all(isinstance(record, dict) for record in records)
    ):
        fail("FCEUX produced a trace with an unsupported schema")
    if len(records) < 6 or records[-1].get("done") is not True:
        fail(f"FCEUX trace did not complete the scripted navigation sequence: records={len(records)}")
    print(f"NES_EMULATOR ok trace={TRACE.relative_to(ROOT)} records={len(records)}")
    if stdout.strip():
        print(stdout.strip())
    if stderr.strip():
        print(stderr.strip(), file=sys.stderr)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cc65-home", help="cc65 source/install root containing bin/cl65")
    parser.add_argument("--fceux", help="FCEUX executable; defaults to NES_FCEUX or PATH")
    parser.add_argument("--build-only", action="store_true", help="build the ROM without running FCEUX")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    cc65_home = resolve_cc65_home(args.cc65_home)
    build_rom(cc65_home)
    if args.build_only:
        return 0
    fceux_name = args.fceux or os.environ.get("NES_FCEUX") or shutil.which("fceux")
    if fceux_name is None:
        fail("cannot find FCEUX; set NES_FCEUX or pass --fceux")
    run_emulator(fceux_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
