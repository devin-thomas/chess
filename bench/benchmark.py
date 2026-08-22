#!/usr/bin/env python3
"""Reproducible benchmark harness for the four chess CLI implementations.

The harness speaks the JSON Lines protocol described in ``docs/PROTOCOL.md``.
It deliberately uses only the Python standard library.  Each measured engine
session is launched by a short-lived helper process so that
``RUSAGE_CHILDREN.ru_maxrss`` is isolated to that session; this makes the
reported peak resident set size comparable between engines and runs.

Example:

    python bench/benchmark.py \
        --engine 'c=./c/chess' \
        --engine 'python=python3 ./python/chess.py' \
        --engine 'typescript=node ./typescript/dist/chess.js' \
        --engine 'rust=./build/chess_rust' \
        --output-dir analysis/benchmark

Commands are tokenized with :func:`shlex.split` and are executed without a
shell.  Source roots can be supplied with repeated ``--source NAME=PATH``;
when omitted, ``c/``, ``python/``, ``typescript/``, and ``rust/`` under the project root
are used when they exist.
"""

from __future__ import annotations

import argparse
import datetime as _datetime
import json
import math
import os
from pathlib import Path
import platform
import re
import resource
import shlex
import signal
import statistics
import subprocess
import sys
import time
from typing import Any, Iterable, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
MASK64 = (1 << 64) - 1
ENGINE_ORDER = ("c", "python", "typescript", "rust")
ENGINE_ALIASES = {
    "c": "c",
    "c-lang": "c",
    "python": "python",
    "python3": "python",
    "py": "python",
    "typescript": "typescript",
    "typescript-node": "typescript",
    "typescript/node": "typescript",
    "ts": "typescript",
    "node": "typescript",
    "rust": "rust",
    "rustc": "rust",
    "rs": "rust",
}

SOURCE_EXTENSIONS = {
    "c": {".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"},
    "python": {".py"},
    "typescript": {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"},
    "rust": {".rs"},
}

EXCLUDED_SOURCE_DIRECTORIES = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "venv",
}

MAX_CAPTURED_TEXT = 20_000


def utc_timestamp() -> str:
    return (
        _datetime.datetime.now(_datetime.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def trim_text(value: str, limit: int = MAX_CAPTURED_TEXT) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n...[truncated]"


def parse_seed(value: str) -> int:
    try:
        parsed = int(value, 0)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("seed must be an integer") from exc
    if parsed < 0 or parsed > MASK64:
        raise argparse.ArgumentTypeError("seed must be between 0 and 2^64-1")
    return parsed


def parse_positive_int(value: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("value must be an integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return parsed


def parse_nonnegative_int(value: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("value must be an integer") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must not be negative")
    return parsed


def canonical_engine_name(name: str) -> str:
    normalized = name.strip().lower()
    try:
        return ENGINE_ALIASES[normalized]
    except KeyError as exc:
        expected = ", ".join(ENGINE_ORDER)
        raise ValueError(f"unknown engine name {name!r}; expected {expected}") from exc


def split_mapping(value: str, option_name: str) -> tuple[str, str]:
    if "=" not in value:
        raise ValueError(f"{option_name} must use NAME=VALUE syntax")
    name, mapped_value = value.split("=", 1)
    if not name.strip() or not mapped_value.strip():
        raise ValueError(f"{option_name} must have a non-empty name and value")
    return name.strip(), mapped_value.strip()


def tokenize_command(command: str) -> list[str]:
    """Tokenize a supplied command without invoking a shell."""

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError as exc:
        raise ValueError(f"invalid command quoting: {exc}") from exc
    if not tokens:
        raise ValueError("command must not be empty")
    return tokens


def request_json_lines(requests: Sequence[Mapping[str, Any]]) -> str:
    return "".join(compact_json(request) + "\n" for request in requests)


def parse_json_lines(stdout: str) -> tuple[list[Any], list[str]]:
    responses: list[Any] = []
    errors: list[str] = []
    for line_number, raw_line in enumerate(stdout.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            responses.append(json.loads(line))
        except json.JSONDecodeError as exc:
            errors.append(f"stdout line {line_number} is not JSON: {exc.msg}")
    return responses, errors


def kill_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError):
            pass
    try:
        process.kill()
    except ProcessLookupError:
        pass


def child_max_rss_bytes() -> tuple[int | None, str]:
    """Return isolated child max RSS in bytes and the measurement source.

    Python exposes ``ru_maxrss`` in bytes on macOS and KiB on Linux.  The
    benchmark helper is a fresh process for every engine session, so the
    ``RUSAGE_CHILDREN`` maximum belongs to that one engine invocation rather
    than to all runs performed by the parent harness.
    """

    try:
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    except (AttributeError, OSError):
        return None, "unavailable"

    raw = float(usage.ru_maxrss)
    if sys.platform == "darwin":
        return int(raw), "getrusage.RUSAGE_CHILDREN.bytes"
    if sys.platform.startswith("linux"):
        return int(raw * 1024), "getrusage.RUSAGE_CHILDREN.kib"
    # This script targets macOS/Linux.  Keeping a conservative fallback makes
    # failures explicit if somebody runs it on another POSIX platform.
    return int(raw * 1024), "getrusage.RUSAGE_CHILDREN.assumed_kib"


def measurement_worker(payload: Mapping[str, Any]) -> dict[str, Any]:
    argv = payload.get("argv")
    input_text = payload.get("input", "")
    cwd = payload.get("cwd")
    timeout_seconds = float(payload.get("timeout_seconds", 60.0))

    if not isinstance(argv, list) or not all(isinstance(item, str) for item in argv):
        return {"worker_error": "argv must be a list of strings"}
    if not isinstance(input_text, str):
        return {"worker_error": "input must be a string"}
    if not isinstance(cwd, str):
        return {"worker_error": "cwd must be a string"}

    started = time.perf_counter()
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=(os.name == "posix"),
        )
    except OSError as exc:
        return {
            "worker_error": f"could not start engine: {exc}",
            "wall_time_seconds": time.perf_counter() - started,
            "child_max_rss_bytes": None,
            "rss_source": "unavailable",
            "exit_code": None,
            "signal": None,
            "timed_out": False,
            "stdout": "",
            "stderr": "",
        }

    timed_out = False
    try:
        stdout_bytes, stderr_bytes = process.communicate(
            input=input_text.encode("utf-8"), timeout=timeout_seconds
        )
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        kill_process_tree(process)
        stdout_bytes, stderr_bytes = process.communicate()
        if exc.output:
            stdout_bytes = exc.output if isinstance(exc.output, bytes) else stdout_bytes
        if exc.stderr:
            stderr_bytes = exc.stderr if isinstance(exc.stderr, bytes) else stderr_bytes

    elapsed = time.perf_counter() - started
    rss_bytes, rss_source = child_max_rss_bytes()
    return {
        "worker_error": None,
        "wall_time_seconds": elapsed,
        "child_max_rss_bytes": rss_bytes,
        "rss_source": rss_source,
        "exit_code": process.returncode if process.returncode is not None and process.returncode >= 0 else None,
        "signal": -process.returncode if process.returncode is not None and process.returncode < 0 else None,
        "timed_out": timed_out,
        "stdout": stdout_bytes.decode("utf-8", errors="replace"),
        "stderr": stderr_bytes.decode("utf-8", errors="replace"),
    }


def measurement_worker_main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("worker payload must be an object")
        result = measurement_worker(payload)
    except Exception as exc:  # pragma: no cover - last-resort worker boundary
        result = {"worker_error": f"measurement worker failed: {exc}"}
    sys.stdout.write(compact_json(result))
    sys.stdout.flush()
    return 0


def measure_engine_session(
    argv: Sequence[str],
    requests: Sequence[Mapping[str, Any]],
    project_root: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    """Run one protocol session and isolate its child RSS measurement."""

    payload = {
        "argv": list(argv),
        "input": request_json_lines(requests),
        "cwd": str(project_root),
        "timeout_seconds": timeout_seconds,
    }
    worker = subprocess.Popen(
        [sys.executable, str(SCRIPT_PATH), "--_measure"],
        cwd=str(project_root),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    worker_timeout = timeout_seconds + max(5.0, min(30.0, timeout_seconds * 0.25))
    try:
        worker_stdout, worker_stderr = worker.communicate(
            input=compact_json(payload).encode("utf-8"), timeout=worker_timeout
        )
    except subprocess.TimeoutExpired:
        kill_process_tree(worker)
        worker_stdout, worker_stderr = worker.communicate()
        return {
            "worker_error": "measurement helper timed out",
            "wall_time_seconds": None,
            "child_max_rss_bytes": None,
            "rss_source": "unavailable",
            "exit_code": None,
            "signal": None,
            "timed_out": True,
            "stdout": "",
            "stderr": worker_stderr.decode("utf-8", errors="replace"),
            "worker_stderr": worker_stderr.decode("utf-8", errors="replace"),
        }

    worker_output = worker_stdout.decode("utf-8", errors="replace")
    try:
        result = json.loads(worker_output)
    except json.JSONDecodeError as exc:
        return {
            "worker_error": f"invalid measurement-helper output: {exc.msg}",
            "wall_time_seconds": None,
            "child_max_rss_bytes": None,
            "rss_source": "unavailable",
            "exit_code": None,
            "signal": None,
            "timed_out": False,
            "stdout": "",
            "stderr": worker_stderr.decode("utf-8", errors="replace"),
            "worker_stdout": trim_text(worker_output),
            "worker_stderr": worker_stderr.decode("utf-8", errors="replace"),
        }

    if not isinstance(result, dict):
        result = {"worker_error": "measurement-helper output was not an object"}
    result["worker_stderr"] = worker_stderr.decode("utf-8", errors="replace")
    return result


class CommentScanner:
    """Small language-aware scanner used for source line counting."""

    def __init__(self, language: str) -> None:
        self.language = language
        self.block_comment = False
        self.quote: str | None = None

    def strip_comments(self, line: str) -> str:
        if self.language == "python":
            return self._strip_python(line)
        return self._strip_c_like(line)

    def _strip_python(self, line: str) -> str:
        output: list[str] = []
        index = 0
        while index < len(line):
            if self.quote is not None:
                delimiter = self.quote
                if line.startswith(delimiter, index):
                    output.append(delimiter)
                    index += len(delimiter)
                    self.quote = None
                    continue
                character = line[index]
                output.append(character)
                index += 1
                if character == "\\" and delimiter in {"'", '"'} and index < len(line):
                    output.append(line[index])
                    index += 1
                elif character == "\n" and delimiter in {"'", '"'}:
                    # Invalid unterminated single-line strings should not
                    # hide all subsequent source from the LOC counter.
                    self.quote = None
                continue

            if line[index] == "#":
                break
            if line.startswith("'''", index) or line.startswith('"""', index):
                self.quote = line[index : index + 3]
                output.append(self.quote)
                index += 3
                continue
            if line[index] in {"'", '"'}:
                self.quote = line[index]
                output.append(line[index])
                index += 1
                continue
            output.append(line[index])
            index += 1
        return "".join(output)

    def _strip_c_like(self, line: str) -> str:
        output: list[str] = []
        index = 0
        while index < len(line):
            if self.block_comment:
                end = line.find("*/", index)
                if end < 0:
                    return "".join(output)
                self.block_comment = False
                index = end + 2
                continue

            if self.quote is not None:
                delimiter = self.quote
                if line[index] == "\\" and index + 1 < len(line):
                    output.append(line[index : index + 2])
                    index += 2
                    continue
                if line.startswith(delimiter, index):
                    output.append(delimiter)
                    index += len(delimiter)
                    self.quote = None
                    continue
                output.append(line[index])
                index += 1
                if line[index - 1] == "\n" and delimiter != "`":
                    self.quote = None
                continue

            if line.startswith("/*", index):
                self.block_comment = True
                index += 2
                continue
            if line.startswith("//", index):
                break
            if line[index] in {"'", '"'} or (
                self.language == "typescript" and line[index] == "`"
            ):
                self.quote = line[index]
                output.append(line[index])
                index += 1
                continue
            output.append(line[index])
            index += 1
        return "".join(output)


def source_files(root: Path, language: str) -> list[Path]:
    extensions = SOURCE_EXTENSIONS[language]
    if root.is_file():
        return [root]

    files: list[Path] = []
    for current, directories, names in os.walk(root, topdown=True, followlinks=False):
        directories[:] = sorted(
            directory
            for directory in directories
            if directory not in EXCLUDED_SOURCE_DIRECTORIES
            and not directory.startswith(".")
        )
        for name in sorted(names):
            path = Path(current) / name
            if path.suffix.lower() in extensions and not name.startswith("."):
                files.append(path)
    return sorted(files)


def count_nonblank_noncomment_lines(root: Path, language: str) -> dict[str, Any]:
    """Count source lines after removing blank and comment-only lines.

    Full-line and trailing comments are ignored while quoted strings are
    preserved.  C-family block comments and Python triple-quoted strings are
    tracked across lines.  This is intentionally a transparent physical-line
    metric, not a language parser or a cyclomatic-complexity measure.
    """

    if not root.exists():
        raise FileNotFoundError(str(root))
    files = source_files(root, language)
    total = 0
    for path in files:
        scanner = CommentScanner(language)
        with path.open("r", encoding="utf-8", errors="replace") as source:
            for line in source:
                if scanner.strip_comments(line).strip():
                    total += 1
    return {"path": str(root), "files": len(files), "lines": total}


def source_metadata(root: Path | None, language: str) -> dict[str, Any]:
    if root is None:
        return {
            "path": None,
            "files": None,
            "lines": None,
            "error": "no source path supplied and default source directory is absent",
        }
    try:
        result = count_nonblank_noncomment_lines(root, language)
    except (OSError, UnicodeError) as exc:
        return {
            "path": str(root),
            "files": None,
            "lines": None,
            "error": f"could not count source lines: {exc}",
        }
    return result


def protocol_base_metadata(measurement: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "wall_time_seconds": measurement.get("wall_time_seconds"),
        "child_max_rss_bytes": measurement.get("child_max_rss_bytes"),
        "rss_source": measurement.get("rss_source"),
        "exit_code": measurement.get("exit_code"),
        "signal": measurement.get("signal"),
        "timed_out": bool(measurement.get("timed_out", False)),
        "stderr": trim_text(str(measurement.get("stderr", ""))),
        "worker_stderr": trim_text(str(measurement.get("worker_stderr", ""))),
        "worker_error": measurement.get("worker_error"),
    }


def is_success_response(response: Any, operation: str) -> bool:
    return (
        isinstance(response, dict)
        and response.get("ok") is True
        and response.get("op") == operation
    )


def run_cpu_benchmark(
    argv: Sequence[str],
    mode: str,
    fen: str | None,
    base_seed: int,
    runs: int,
    warmups: int,
    max_plies: int,
    trace: bool,
    project_root: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    def run_request(seed: int) -> dict[str, Any]:
        request: dict[str, Any] = {
            "op": "run",
            "mode": mode,
            "seed": seed,
            "max_plies": max_plies,
            "trace": trace,
        }
        if fen is not None:
            request["fen"] = fen
        measurement = measure_engine_session(
            argv, [request], project_root, timeout_seconds
        )
        responses, parse_errors = parse_json_lines(str(measurement.get("stdout", "")))
        response = responses[0] if len(responses) == 1 else None
        protocol_ok = (
            not measurement.get("worker_error")
            and not measurement.get("timed_out")
            and measurement.get("exit_code") == 0
            and not parse_errors
            and len(responses) == 1
            and is_success_response(response, "run")
        )
        result = protocol_base_metadata(measurement)
        plies = response.get("plies") if isinstance(response, dict) else None
        wall_time = result.get("wall_time_seconds")
        wall_time_per_ply = (
            float(wall_time) / plies
            if protocol_ok
            and isinstance(wall_time, (int, float))
            and isinstance(plies, int)
            and not isinstance(plies, bool)
            and plies > 0
            else None
        )
        result.update(
            {
                "seed": seed,
                "request": request,
                "protocol_ok": protocol_ok,
                "response": response if protocol_ok else None,
                "wall_time_seconds_per_ply": wall_time_per_ply,
                "parse_errors": parse_errors,
                "stdout": "" if protocol_ok else trim_text(str(measurement.get("stdout", ""))),
            }
        )
        return result

    warmup_results = [run_request((base_seed + index) & MASK64) for index in range(warmups)]
    measured_results = [
        run_request((base_seed + warmups + index) & MASK64) for index in range(runs)
    ]
    wall_values = [
        result["wall_time_seconds"]
        for result in measured_results
        if isinstance(result.get("wall_time_seconds"), (int, float))
    ]
    rss_values = [
        result["child_max_rss_bytes"]
        for result in measured_results
        if isinstance(result.get("child_max_rss_bytes"), (int, float))
    ]
    wall_per_ply_values = [
        result["wall_time_seconds_per_ply"]
        for result in measured_results
        if isinstance(result.get("wall_time_seconds_per_ply"), (int, float))
    ]
    return {
        "warmups": [
            {
                "seed": result.get("seed"),
                "protocol_ok": result.get("protocol_ok", False),
                "wall_time_seconds": result.get("wall_time_seconds"),
                "child_max_rss_bytes": result.get("child_max_rss_bytes"),
                "error": result.get("worker_error"),
            }
            for result in warmup_results
        ],
        "runs": measured_results,
        "summary": {
            "runs_requested": runs,
            "runs_successful": sum(
                1 for result in measured_results if result.get("protocol_ok")
            ),
            "wall_time_seconds": summarize_numbers(wall_values),
            "wall_time_seconds_per_ply": summarize_numbers(wall_per_ply_values),
            "child_max_rss_bytes": summarize_numbers(rss_values),
        },
    }


def summarize_numbers(values: Iterable[float | int]) -> dict[str, Any]:
    numeric = [float(value) for value in values]
    if not numeric:
        return {
            "count": 0,
            "mean": None,
            "median": None,
            "minimum": None,
            "maximum": None,
            "stdev": None,
        }
    return {
        "count": len(numeric),
        "mean": statistics.fmean(numeric),
        "median": statistics.median(numeric),
        "minimum": min(numeric),
        "maximum": max(numeric),
        "stdev": statistics.stdev(numeric) if len(numeric) > 1 else 0.0,
    }


def regularized_gamma_q(a: float, x: float) -> float:
    """Compute Q(a, x), sufficient for a chi-square survival probability."""

    if a <= 0 or x < 0:
        return float("nan")
    if x == 0:
        return 1.0
    epsilon = 3.0e-14
    tiny = 1.0e-300
    max_iterations = 1_000

    if x < a + 1.0:
        # Series for the regularized lower incomplete gamma P(a, x).
        term = 1.0 / a
        total = term
        denominator = a
        for _ in range(max_iterations):
            denominator += 1.0
            term *= x / denominator
            total += term
            if abs(term) <= abs(total) * epsilon:
                break
        lower = total * math.exp(-x + a * math.log(x) - math.lgamma(a))
        return max(0.0, min(1.0, 1.0 - lower))

    # Continued fraction for the regularized upper incomplete gamma Q(a, x).
    b = x + 1.0 - a
    c = 1.0 / tiny
    d = 1.0 / max(b, tiny)
    h = d
    for index in range(1, max_iterations + 1):
        an = -float(index) * (float(index) - a)
        b += 2.0
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) <= epsilon:
            break
    upper = math.exp(-x + a * math.log(x) - math.lgamma(a)) * h
    return max(0.0, min(1.0, upper))


def pearson_lag1(values: Sequence[int]) -> float | None:
    if len(values) < 2:
        return None
    first = [float(value) for value in values[:-1]]
    second = [float(value) for value in values[1:]]
    first_mean = statistics.fmean(first)
    second_mean = statistics.fmean(second)
    covariance = sum(
        (left - first_mean) * (right - second_mean)
        for left, right in zip(first, second)
    )
    first_variance = sum((value - first_mean) ** 2 for value in first)
    second_variance = sum((value - second_mean) ** 2 for value in second)
    denominator = math.sqrt(first_variance * second_variance)
    if denominator == 0:
        return None
    return covariance / denominator


def extract_sample_sequence(response: Mapping[str, Any], requested: int) -> list[str] | None:
    for key in ("sequence", "sampled_moves", "samples"):
        value = response.get(key)
        if isinstance(value, list) and all(isinstance(item, str) for item in value):
            return value
    value = response.get("moves")
    if (
        isinstance(value, list)
        and len(value) == requested
        and all(isinstance(item, str) for item in value)
    ):
        return value
    return None


def extract_counts(
    response: Mapping[str, Any], sequence: Sequence[str] | None
) -> tuple[dict[str, int] | None, list[str]]:
    errors: list[str] = []
    raw_counts = response.get("counts")
    counts: dict[str, int] | None = None
    if isinstance(raw_counts, dict):
        counts = {}
        for key, value in raw_counts.items():
            if not isinstance(key, str) or isinstance(value, bool) or not isinstance(value, int):
                errors.append("sample counts must map move strings to integer counts")
                continue
            if value < 0:
                errors.append(f"sample count for {key!r} is negative")
                continue
            counts[key] = value
    elif raw_counts is not None:
        errors.append("sample counts must be an object")

    if sequence is not None:
        sequence_counts: dict[str, int] = {}
        for move in sequence:
            sequence_counts[move] = sequence_counts.get(move, 0) + 1
        if counts is None:
            counts = sequence_counts
        elif counts != sequence_counts:
            errors.append("sample counts do not match the sampled move sequence")
            counts = sequence_counts
    return counts, errors


def analyze_randomness(
    legal_moves: Sequence[str],
    sample_response: Mapping[str, Any],
    requested_samples: int,
) -> dict[str, Any]:
    categories = sorted(set(legal_moves))
    sequence = extract_sample_sequence(sample_response, requested_samples)
    counts, errors = extract_counts(sample_response, sequence)
    if not categories:
        errors.append("root position has no legal moves; randomness is undefined")
    if counts is None:
        errors.append("sample response has neither usable counts nor a move sequence")
        counts = {}

    response_samples = sample_response.get("samples")
    if isinstance(response_samples, int) and response_samples != requested_samples:
        errors.append(
            f"sample response reports {response_samples} samples, expected {requested_samples}"
        )

    unexpected = sorted(move for move in counts if move not in categories)
    unexpected_total = sum(counts[move] for move in unexpected)
    count_total = sum(counts.values())
    if count_total != requested_samples:
        errors.append(
            f"sample counts sum to {count_total}, expected {requested_samples}"
        )
    if unexpected:
        errors.append("sample response contains moves outside the root legal-move set")

    result: dict[str, Any] = {
        "valid": not errors,
        "errors": errors,
        "requested_samples": requested_samples,
        "observed_samples": count_total,
        "category_count": len(categories),
        "categories": categories,
        "counts": {category: counts.get(category, 0) for category in categories},
        "unexpected_moves": {move: counts[move] for move in unexpected},
        "unexpected_sample_count": unexpected_total,
        "sequence_available": sequence is not None,
        "sequence_length": len(sequence) if sequence is not None else None,
        "chi_square": None,
        "entropy_bits": None,
        "maximum_entropy_bits": None,
        "normalized_entropy": None,
        "max_absolute_deviation": None,
        "max_deviation_ratio": None,
        "lag_1_correlation": None,
    }
    if not categories or count_total <= 0:
        return result

    category_count = len(categories)
    expected = count_total / category_count
    observed = [counts.get(category, 0) for category in categories]
    chi_square_statistic = sum(
        ((value - expected) ** 2) / expected for value in observed
    )
    degrees_of_freedom = category_count - 1
    result["expected_count_per_category"] = expected
    result["chi_square"] = {
        "statistic": chi_square_statistic,
        "degrees_of_freedom": degrees_of_freedom,
        "p_value": (
            regularized_gamma_q(degrees_of_freedom / 2.0, chi_square_statistic / 2.0)
            if degrees_of_freedom > 0
            else None
        ),
    }

    probabilities = [value / count_total for value in observed if value > 0]
    entropy = -sum(probability * math.log2(probability) for probability in probabilities)
    maximum_entropy = math.log2(category_count) if category_count > 1 else 0.0
    result["entropy_bits"] = entropy
    result["maximum_entropy_bits"] = maximum_entropy
    result["normalized_entropy"] = entropy / maximum_entropy if maximum_entropy else None

    maximum_deviation = max(abs(value - expected) for value in observed)
    result["max_absolute_deviation"] = maximum_deviation
    result["max_deviation_ratio"] = maximum_deviation / expected if expected else None

    if sequence is not None:
        index_by_move = {move: index for index, move in enumerate(categories)}
        if all(move in index_by_move for move in sequence):
            result["lag_1_correlation"] = pearson_lag1(
                [index_by_move[move] for move in sequence]
            )
        else:
            result["errors"].append(
                "lag-1 correlation could not encode an unexpected sampled move"
            )
            result["valid"] = False
    return result


def run_randomness_benchmark(
    argv: Sequence[str],
    mode: str,
    fen: str | None,
    seed: int,
    samples: int,
    project_root: Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    new_request: dict[str, Any] = {"op": "new", "mode": mode, "seed": seed}
    if fen is not None:
        new_request["fen"] = fen
    requests: list[dict[str, Any]] = [
        new_request,
        {"op": "legal_moves"},
        {"op": "sample", "samples": samples, "seed": seed},
    ]
    measurement = measure_engine_session(argv, requests, project_root, timeout_seconds)
    responses, parse_errors = parse_json_lines(str(measurement.get("stdout", "")))
    legal_response = responses[1] if len(responses) >= 2 else None
    sample_response = responses[2] if len(responses) >= 3 else None
    legal_moves = (
        legal_response.get("moves", [])
        if isinstance(legal_response, dict)
        else []
    )
    if not isinstance(legal_moves, list) or not all(
        isinstance(move, str) for move in legal_moves
    ):
        legal_moves = []
        parse_errors.append("legal_moves response must contain a string list in moves")
    protocol_ok = (
        not measurement.get("worker_error")
        and not measurement.get("timed_out")
        and measurement.get("exit_code") == 0
        and not parse_errors
        and len(responses) == len(requests)
        and all(
            is_success_response(response, operation)
            for response, operation in zip(
                responses, ("new", "legal_moves", "sample")
            )
        )
        and isinstance(sample_response, dict)
    )
    result = protocol_base_metadata(measurement)
    result.update(
        {
            "seed": seed,
            "requested_samples": samples,
            "protocol_ok": protocol_ok,
            "legal_move_count": len(legal_moves),
            "parse_errors": parse_errors,
            "sample_response_keys": (
                sorted(sample_response.keys()) if isinstance(sample_response, dict) else []
            ),
            "analysis": (
                analyze_randomness(legal_moves, sample_response, samples)
                if isinstance(sample_response, dict)
                else {
                    "valid": False,
                    "errors": ["sample response was unavailable"],
                }
            ),
            "stdout": "" if protocol_ok else trim_text(str(measurement.get("stdout", ""))),
        }
    )
    if not protocol_ok:
        result["analysis"]["valid"] = False
        result["analysis"].setdefault("errors", []).extend(parse_errors)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Benchmark C, Python, TypeScript/Node, and Rust chess engines through "
            "the shared JSON Lines protocol."
        )
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="directory receiving benchmark.json and benchmark.md",
    )
    parser.add_argument(
        "--engine",
        action="append",
        default=[],
        metavar="NAME=COMMAND",
        help="engine command; repeat for c, python, typescript, and rust",
    )
    parser.add_argument("--c-command", "--c", dest="c_command")
    parser.add_argument("--python-command", "--python", dest="python_command")
    parser.add_argument(
        "--typescript-command",
        "--typescript",
        "--ts-command",
        dest="typescript_command",
    )
    parser.add_argument("--rust-command", "--rust", "--rustc-command", dest="rust_command")
    parser.add_argument(
        "--source",
        action="append",
        default=[],
        metavar="NAME=PATH",
        help="source root for LOC counting; repeat for any engine",
    )
    parser.add_argument("--c-source", dest="c_source")
    parser.add_argument("--python-source", dest="python_source")
    parser.add_argument("--typescript-source", "--ts-source", dest="typescript_source")
    parser.add_argument("--rust-source", "--rs-source", dest="rust_source")
    parser.add_argument(
        "--project-root",
        default=str(SCRIPT_PATH.parent.parent),
        help="working directory for engines and default source roots",
    )
    parser.add_argument(
        "--mode",
        choices=("basic", "all-rules-enabled"),
        default="all-rules-enabled",
    )
    parser.add_argument("--fen", help="optional starting FEN passed to each protocol session")
    parser.add_argument("--runs", type=parse_positive_int, default=3)
    parser.add_argument("--warmups", type=parse_nonnegative_int, default=0)
    parser.add_argument("--max-plies", type=parse_positive_int, default=200)
    parser.add_argument("--samples", type=parse_positive_int, default=10_000)
    parser.add_argument("--seed", type=parse_seed, default=1)
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=60.0,
        help="per-engine-session timeout (default: 60)",
    )
    parser.add_argument(
        "--trace",
        action="store_true",
        help="ask run responses to include their complete move trace",
    )
    parser.add_argument("--json-name", default="benchmark.json")
    parser.add_argument("--markdown-name", default="benchmark.md")
    return parser


def resolve_commands(args: argparse.Namespace) -> dict[str, tuple[str, list[str]]]:
    commands: dict[str, tuple[str, list[str]]] = {}
    direct_values = {
        "c": args.c_command,
        "python": args.python_command,
        "typescript": args.typescript_command,
        "rust": args.rust_command,
    }
    for name, command in direct_values.items():
        if command is not None:
            commands[name] = (command, tokenize_command(command))

    for specification in args.engine:
        raw_name, command = split_mapping(specification, "--engine")
        name = canonical_engine_name(raw_name)
        if name in commands:
            raise ValueError(f"engine {name!r} was supplied more than once")
        commands[name] = (command, tokenize_command(command))

    missing = [name for name in ENGINE_ORDER if name not in commands]
    if missing:
        raise ValueError("missing engine command(s): " + ", ".join(missing))
    return {name: commands[name] for name in ENGINE_ORDER}


def resolve_sources(args: argparse.Namespace, project_root: Path) -> dict[str, Path | None]:
    sources: dict[str, Path | None] = {name: None for name in ENGINE_ORDER}
    direct_values = {
        "c": args.c_source,
        "python": args.python_source,
        "typescript": args.typescript_source,
        "rust": args.rust_source,
    }
    for name, value in direct_values.items():
        if value is not None:
            sources[name] = (project_root / value).resolve() if not os.path.isabs(value) else Path(value).resolve()

    for specification in args.source:
        raw_name, raw_path = split_mapping(specification, "--source")
        name = canonical_engine_name(raw_name)
        if sources[name] is not None:
            raise ValueError(f"source path for {name!r} was supplied more than once")
        sources[name] = (
            (project_root / raw_path).resolve()
            if not os.path.isabs(raw_path)
            else Path(raw_path).resolve()
        )

    for name in ENGINE_ORDER:
        if sources[name] is None:
            default_path = project_root / name
            if default_path.exists():
                sources[name] = default_path
    return sources


def engine_has_failure(engine: Mapping[str, Any]) -> bool:
    cpu = engine.get("cpu_vs_cpu", {})
    runs = cpu.get("runs", []) if isinstance(cpu, dict) else []
    if any(not run.get("protocol_ok", False) for run in runs if isinstance(run, dict)):
        return True
    randomness = engine.get("randomness", {})
    if not isinstance(randomness, dict) or not randomness.get("protocol_ok", False):
        return True
    analysis = randomness.get("analysis", {})
    return not isinstance(analysis, dict) or not analysis.get("valid", False)


def make_report(
    configuration: Mapping[str, Any], engines: Sequence[Mapping[str, Any]], started_at: str
) -> dict[str, Any]:
    failures = [engine["name"] for engine in engines if engine_has_failure(engine)]
    return {
        "schema_version": 1,
        "benchmark": "orthodox-chess-cli",
        "started_at_utc": started_at,
        "finished_at_utc": utc_timestamp(),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "configuration": dict(configuration),
        "engines": list(engines),
        "failures": failures,
        "measurement_notes": [
            "Each protocol session is launched by a fresh helper process.",
            "Child max RSS uses resource.getrusage(RUSAGE_CHILDREN); macOS bytes and Linux KiB are normalized to bytes.",
            "Source LOC excludes blank/comment-only physical lines and tracks quoted strings and block comments.",
            "Randomness statistics treat the sorted root legal-move list as the uniform category universe.",
        ],
    }


def markdown_value(value: Any, digits: int = 6) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.{digits}g}"
    return str(value)


def markdown_escape(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def make_markdown(report: Mapping[str, Any]) -> str:
    configuration = report["configuration"]
    lines = [
        "# Chess CLI Benchmark",
        "",
        "Generated at `" + str(report["finished_at_utc"]) + "`.",
        "",
        "## Configuration",
        "",
        f"- Mode: `{configuration['mode']}`",
        f"- CPU-vs-CPU runs: `{configuration['runs']}` measured, `{configuration['warmups']}` warmups",
        f"- Maximum plies: `{configuration['max_plies']}`",
        f"- Randomness samples: `{configuration['samples']}`",
        f"- Base seed: `{configuration['seed']}`",
        f"- Session timeout: `{configuration['timeout_seconds']}` seconds",
        f"- Project root: `{configuration['project_root']}`",
        "",
        "## Comparison",
        "",
        "| Engine | Source LOC | Successful runs | Mean wall s | Mean s/ply | Max RSS MiB | Chi-square | Entropy bits | Max deviation | Lag-1 correlation |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for engine in report["engines"]:
        source = engine.get("source", {})
        cpu = engine.get("cpu_vs_cpu", {})
        cpu_summary = cpu.get("summary", {})
        wall = cpu_summary.get("wall_time_seconds", {})
        wall_per_ply = cpu_summary.get("wall_time_seconds_per_ply", {})
        rss = cpu_summary.get("child_max_rss_bytes", {})
        randomness = engine.get("randomness", {})
        analysis = randomness.get("analysis", {})
        chi_square = analysis.get("chi_square") or {}
        max_rss = rss.get("maximum")
        max_rss_mib = max_rss / (1024 * 1024) if isinstance(max_rss, (int, float)) else None
        lines.append(
            "| "
            + " | ".join(
                [
                    markdown_escape(engine["name"]),
                    markdown_value(source.get("lines")),
                    markdown_value(cpu_summary.get("runs_successful")),
                    markdown_value(wall.get("mean")),
                    markdown_value(wall_per_ply.get("mean")),
                    markdown_value(max_rss_mib),
                    markdown_value(chi_square.get("statistic")),
                    markdown_value(analysis.get("entropy_bits")),
                    markdown_value(analysis.get("max_deviation_ratio")),
                    markdown_value(analysis.get("lag_1_correlation")),
                ]
            )
            + "|"
        )

    lines.extend(["", "## Engine Details", ""])
    for engine in report["engines"]:
        source = engine.get("source", {})
        cpu = engine.get("cpu_vs_cpu", {})
        randomness = engine.get("randomness", {})
        analysis = randomness.get("analysis", {})
        lines.extend(
            [
                f"### `{engine['name']}`",
                "",
                f"- Command: `{markdown_escape(engine['command'])}`",
                f"- Source path: `{markdown_escape(source.get('path') or 'not supplied')}`",
                f"- Source files counted: `{markdown_value(source.get('files'))}`",
                "",
                "#### CPU-vs-CPU runs",
                "",
                "| Run | Seed | Wall s | S/ply | Max RSS MiB | Protocol OK | Termination | Result |",
                "| ---: | ---: | ---: | ---: | ---: | :---: | --- | --- |",
            ]
        )
        for index, run in enumerate(cpu.get("runs", []), start=1):
            response = run.get("response") or {}
            lines.append(
                "| "
                + " | ".join(
                    [
                        str(index),
                        markdown_value(run.get("seed")),
                        markdown_value(run.get("wall_time_seconds")),
                        markdown_value(run.get("wall_time_seconds_per_ply")),
                        markdown_value(
                            run.get("child_max_rss_bytes") / (1024 * 1024)
                            if isinstance(run.get("child_max_rss_bytes"), (int, float))
                            else None
                        ),
                        "yes" if run.get("protocol_ok") else "no",
                        markdown_escape(response.get("termination", "n/a")),
                        markdown_escape(response.get("result", "n/a")),
                    ]
                )
                + "|"
            )
        lines.extend(
            [
                "",
                "#### Randomness sample",
                "",
                f"- Protocol OK: `{'yes' if randomness.get('protocol_ok') else 'no'}`",
                f"- Root legal moves: `{markdown_value(randomness.get('legal_move_count'))}`",
                f"- Analysis valid: `{'yes' if analysis.get('valid') else 'no'}`",
                f"- Chi-square statistic: `{markdown_value((analysis.get('chi_square') or {}).get('statistic'))}`",
                f"- Chi-square p-value: `{markdown_value((analysis.get('chi_square') or {}).get('p_value'))}`",
                f"- Entropy: `{markdown_value(analysis.get('entropy_bits'))}` / `{markdown_value(analysis.get('maximum_entropy_bits'))}` bits",
                f"- Normalized entropy: `{markdown_value(analysis.get('normalized_entropy'))}`",
                f"- Maximum deviation ratio: `{markdown_value(analysis.get('max_deviation_ratio'))}`",
                f"- Lag-1 correlation: `{markdown_value(analysis.get('lag_1_correlation'))}`",
            ]
        )
        if analysis.get("errors"):
            lines.append("- Analysis errors: " + "; ".join(str(error) for error in analysis["errors"]))
        lines.append("")

    lines.extend(
        [
            "## Method",
            "",
            "- One fresh engine process is used for each measured CPU-vs-CPU run and each randomness session.",
            "- Wall time includes process startup, protocol I/O, and the requested operation.",
            "- Peak RSS is reported for the engine child, not for this reporting process; values in the table are MiB.",
            "- Randomness is evaluated against uniform selection from the sorted root legal moves. Entropy is Shannon entropy in bits; maximum deviation is normalized by the expected per-move count.",
            "- A missing sequence in a valid `sample` response leaves lag-1 correlation as `n/a`; counts still support the other statistics.",
            "",
            "## Reproduction",
            "",
            "The exact engine commands, working directory, mode, seeds, run counts, and sample count are recorded in `benchmark.json`.",
            "",
        ]
    )
    if report.get("failures"):
        lines.extend(
            [
                "## Failures",
                "",
                "The following engines had a process, protocol, or randomness-analysis failure: "
                + ", ".join(f"`{name}`" for name in report["failures"])
                + ".",
                "",
            ]
        )
    return "\n".join(lines)


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    if args.timeout_seconds <= 0 or not math.isfinite(args.timeout_seconds):
        raise ValueError("--timeout-seconds must be a finite value greater than zero")
    project_root = Path(args.project_root).expanduser().resolve()
    if not project_root.is_dir():
        raise ValueError(f"project root is not a directory: {project_root}")
    commands = resolve_commands(args)
    sources = resolve_sources(args, project_root)
    started_at = utc_timestamp()
    configuration = {
        "mode": args.mode,
        "fen": args.fen,
        "runs": args.runs,
        "warmups": args.warmups,
        "max_plies": args.max_plies,
        "samples": args.samples,
        "seed": args.seed,
        "timeout_seconds": args.timeout_seconds,
        "trace": args.trace,
        "project_root": str(project_root),
        "source_metric": "nonblank_noncomment_physical_lines",
    }
    engine_results: list[dict[str, Any]] = []
    for name in ENGINE_ORDER:
        command_text, argv = commands[name]
        engine_results.append(
            {
                "name": name,
                "command": command_text,
                "argv": argv,
                "source": source_metadata(sources[name], name),
                "cpu_vs_cpu": run_cpu_benchmark(
                    argv,
                    args.mode,
                    args.fen,
                    args.seed,
                    args.runs,
                    args.warmups,
                    args.max_plies,
                    args.trace,
                    project_root,
                    args.timeout_seconds,
                ),
                "randomness": run_randomness_benchmark(
                    argv,
                    args.mode,
                    args.fen,
                    args.seed,
                    args.samples,
                    project_root,
                    args.timeout_seconds,
                ),
            }
        )
    return make_report(configuration, engine_results, started_at)


def write_report(report: Mapping[str, Any], output_dir: Path, json_name: str, markdown_name: str) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / json_name
    markdown_path = output_dir / markdown_name
    json_path.write_text(
        json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    markdown_path.write_text(make_markdown(report), encoding="utf-8")
    return json_path, markdown_path


def main(argv: Sequence[str] | None = None) -> int:
    command_line = list(sys.argv[1:] if argv is None else argv)
    if command_line and command_line[0] == "--_measure":
        return measurement_worker_main()

    parser = build_parser()
    args = parser.parse_args(command_line)
    try:
        report = run_benchmark(args)
        output_dir = Path(args.output_dir).expanduser().resolve()
        json_path, markdown_path = write_report(
            report, output_dir, args.json_name, args.markdown_name
        )
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
        return 2

    print(f"JSON report: {json_path}")
    print(f"Markdown report: {markdown_path}")
    if report["failures"]:
        print("Failures: " + ", ".join(report["failures"]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
