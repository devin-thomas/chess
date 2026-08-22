#!/usr/bin/env python3
"""Run the language-independent JSONL conformance corpus.

The corpus is data, not an engine-specific test harness. Each case starts a
fresh process, sends one JSON request at a time, and reads exactly one JSON
response for each request. With two or more supplied engines, the runner
compares their protocol-level semantics in addition to checking the corpus
assertions.

Examples:

    python3 tests/run_shared.py \
        --python "python3 python/chess_cpu.py" \
        --c "./build/chess_c" \
        --typescript "node --experimental-strip-types typescript/chess_cpu.ts"

    python3 tests/run_shared.py --engine py="python3 python/chess_cpu.py"

Diagnostics written by an engine to stderr are retained for failure reports;
they are not themselves a conformance failure because the protocol permits
diagnostics on stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = ROOT / "shared" / "cases.json"
DEFAULT_TIMEOUT = 10.0

STATE_FIELDS = (
    "mode",
    "board",
    "side_to_move",
    "castling_rights",
    "en_passant_target",
    "halfmove_clock",
    "fullmove_number",
    "status",
    "check",
    "outcome",
    "claimable_draws",
    "repetition_counts",
    "moves",
)


class RunnerError(Exception):
    """A failure with enough context to produce a useful CLI diagnostic."""


def parse_command(value: str) -> list[str]:
    """Parse a shell-like command without invoking a shell."""

    command = shlex.split(value)
    if not command:
        raise argparse.ArgumentTypeError("engine command cannot be empty")
    return command


def parse_engine(value: str) -> tuple[str, list[str]]:
    """Parse NAME=COMMAND, preserving command arguments with shlex."""

    name, separator, command = value.partition("=")
    if not separator or not name.strip():
        raise argparse.ArgumentTypeError("engine must be NAME=COMMAND")
    try:
        argv = parse_command(command)
    except argparse.ArgumentTypeError as exc:
        raise argparse.ArgumentTypeError(f"{name}: {exc}") from exc
    return name.strip(), argv


def load_corpus(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RunnerError(f"cannot load corpus {path}: {exc}") from exc
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        raise RunnerError("corpus must be an object with schema_version 1")
    cases = raw.get("cases")
    if not isinstance(cases, list) or not cases:
        raise RunnerError("corpus must contain a non-empty cases array")
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            raise RunnerError(f"case {index} is not an object")
        if not isinstance(case.get("id"), str) or not case["id"]:
            raise RunnerError(f"case {index} has no non-empty id")
        if not isinstance(case.get("requests"), list) or not case["requests"]:
            raise RunnerError(f"case {case['id']} has no requests")
        for request_index, request in enumerate(case["requests"]):
            if not isinstance(request, dict) or not isinstance(request.get("op"), str):
                raise RunnerError(
                    f"case {case['id']} request {request_index} must have an op"
                )
        assertions = case.get("assertions", [])
        if not isinstance(assertions, list):
            raise RunnerError(f"case {case['id']} assertions must be an array")
    return cases


def json_pointer(value: Any, pointer: str) -> Any:
    """Resolve an RFC 6901 JSON Pointer, with an empty pointer meaning root."""

    if not isinstance(pointer, str) or (pointer and not pointer.startswith("/")):
        raise RunnerError(f"invalid JSON pointer {pointer!r}")
    current = value
    if pointer == "":
        return current
    for raw_token in pointer[1:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            try:
                index = int(token)
            except ValueError as exc:
                raise RunnerError(f"array pointer token is not an index: {token!r}") from exc
            if index < 0 or index >= len(current):
                raise RunnerError(f"array pointer index out of range: {token!r}")
            current = current[index]
        elif isinstance(current, dict):
            if token not in current:
                raise RunnerError(f"pointer token not found: {token!r}")
            current = current[token]
        else:
            raise RunnerError(f"cannot traverse {token!r} through {type(current).__name__}")
    return current


def _sorted_claims(value: Any) -> Any:
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return sorted(value)
    return value


def semantic_state(state: Any) -> Any:
    """Project a state onto fields defined by the protocol.

    Repetition keys are deliberately not compared: the protocol exposes their
    counts but does not standardize the serialized key encoding. The sorted
    multiset of counts still checks that history is being retained.
    """

    if not isinstance(state, dict):
        return state
    result: dict[str, Any] = {}
    for field in STATE_FIELDS:
        if field not in state:
            continue
        field_value = state[field]
        if field == "repetition_counts":
            if isinstance(field_value, dict):
                field_value = sorted(field_value.values())
            result[field] = field_value
        elif field == "claimable_draws":
            result[field] = _sorted_claims(field_value)
        else:
            result[field] = semantic_value(field_value)
    return result


def semantic_value(value: Any, *, parent_key: str | None = None) -> Any:
    if parent_key == "state":
        return semantic_state(value)
    if isinstance(value, dict):
        return {key: semantic_value(value[key], parent_key=key) for key in sorted(value)}
    if isinstance(value, list):
        return [semantic_value(item, parent_key=parent_key) for item in value]
    return value


def semantic_response(response: Any) -> Any:
    """Keep only stable, observable response fields for cross-engine checks."""

    if not isinstance(response, dict):
        return response
    operation = response.get("op")
    if response.get("ok") is False:
        result: dict[str, Any] = {
            "ok": False,
            "op": operation,
            "error": {"code": response.get("error", {}).get("code")},
        }
        if "state" in response:
            result["state"] = semantic_state(response["state"])
        return result

    result = {"ok": response.get("ok"), "op": operation}
    if operation in {"new", "state", "play", "clock_event", "restore"}:
        if "state" in response:
            result["state"] = semantic_state(response["state"])
    elif operation == "legal_moves":
        result["moves"] = response.get("moves")
    elif operation == "perft":
        result["depth"] = response.get("depth")
        result["nodes"] = response.get("nodes")
    elif operation == "sample":
        for field in ("seed", "moves", "counts", "samples"):
            if field in response:
                result[field] = semantic_value(response[field])
    elif operation == "run":
        for field in ("seed", "moves", "plies", "termination", "result"):
            if field in response:
                result[field] = semantic_value(response[field])
        if "final" in response:
            result["final"] = semantic_state(response["final"])
    else:
        result.update(
            {
                key: semantic_value(response[key])
                for key in sorted(response)
                if key not in {"ok", "op"}
            }
        )
    return result


def drain_stderr(selector: Any, stderr_buffer: bytearray) -> None:
    """Drain currently available diagnostics so an engine cannot block on stderr."""

    for key, _ in list(selector.select(timeout=0)):
        if key.data != "stderr":
            continue
        data = os.read(key.fileobj.fileno(), 65536)
        if data:
            stderr_buffer.extend(data)
        else:
            selector.unregister(key.fileobj)


class EngineSession:
    def __init__(self, name: str, argv: Sequence[str], timeout: float) -> None:
        self.name = name
        self.argv = list(argv)
        self.timeout = timeout
        try:
            self.process = subprocess.Popen(
                self.argv,
                cwd=ROOT,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
        except OSError as exc:
            raise RunnerError(f"{name}: cannot start {self.argv!r}: {exc}") from exc
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        assert self.process.stderr is not None
        self.selector = __import__("selectors").DefaultSelector()
        self.selector.register(self.process.stdout, __import__("selectors").EVENT_READ, "stdout")
        self.selector.register(self.process.stderr, __import__("selectors").EVENT_READ, "stderr")
        self.stdout_buffer = bytearray()
        self.stderr_buffer = bytearray()

    def _read_response(self, case_id: str, request_index: int) -> dict[str, Any]:
        assert self.process.stdout is not None
        deadline = time.monotonic() + self.timeout
        while True:
            newline = self.stdout_buffer.find(b"\n")
            if newline >= 0:
                raw_line = bytes(self.stdout_buffer[:newline])
                del self.stdout_buffer[: newline + 1]
                if not raw_line.strip():
                    continue
                try:
                    parsed = json.loads(raw_line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise RunnerError(
                        f"{self.name} case {case_id} request {request_index}: "
                        f"invalid JSON response {raw_line!r}: {exc}"
                    ) from exc
                if not isinstance(parsed, dict):
                    raise RunnerError(
                        f"{self.name} case {case_id} request {request_index}: "
                        "response must be a JSON object"
                    )
                return parsed

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RunnerError(
                    f"{self.name} case {case_id} request {request_index}: "
                    f"timed out after {self.timeout:.1f}s"
                )
            events = self.selector.select(timeout=remaining)
            if not events:
                continue
            for key, _ in events:
                data = os.read(key.fileobj.fileno(), 65536)
                if key.data == "stderr":
                    if data:
                        self.stderr_buffer.extend(data)
                    else:
                        self.selector.unregister(key.fileobj)
                elif data:
                    self.stdout_buffer.extend(data)
                else:
                    raise RunnerError(
                        f"{self.name} case {case_id} request {request_index}: "
                        "engine closed stdout before responding"
                    )

    def send_case(self, case: Mapping[str, Any]) -> list[dict[str, Any]]:
        assert self.process.stdin is not None
        requests = case["requests"]
        responses: list[dict[str, Any]] = []
        for request_index, request in enumerate(requests):
            payload = (json.dumps(request, separators=(",", ":"), ensure_ascii=True) + "\n").encode(
                "utf-8"
            )
            try:
                self.process.stdin.write(payload)
                self.process.stdin.flush()
            except OSError as exc:
                raise RunnerError(
                    f"{self.name} case {case['id']} request {request_index}: "
                    f"cannot write request: {exc}"
                ) from exc
            responses.append(self._read_response(case["id"], request_index))
            drain_stderr(self.selector, self.stderr_buffer)
        return responses

    def close(self) -> str:
        if self.process.stdin is not None:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        drain_stderr(self.selector, self.stderr_buffer)
        try:
            self.selector.close()
        except OSError:
            pass
        return self.stderr_buffer.decode("utf-8", errors="replace")


def check_assertion(case_id: str, assertion: Mapping[str, Any], responses: Sequence[Any]) -> None:
    try:
        response_index = int(assertion["response"])
        path = assertion.get("path", "")
    except (KeyError, TypeError, ValueError) as exc:
        raise RunnerError(f"case {case_id}: malformed assertion {assertion!r}") from exc
    if response_index < 0 or response_index >= len(responses):
        raise RunnerError(f"case {case_id}: assertion response index out of range")
    actual = json_pointer(responses[response_index], path)

    if "same_as" in assertion:
        reference = assertion["same_as"]
        if not isinstance(reference, dict):
            raise RunnerError(f"case {case_id}: same_as must be an object")
        try:
            reference_value = json_pointer(
                responses[int(reference["response"])], reference.get("path", "")
            )
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            raise RunnerError(f"case {case_id}: malformed same_as assertion") from exc
        if semantic_value(actual, parent_key="state" if path == "/state" else None) != semantic_value(
            reference_value, parent_key="state" if reference.get("path", "") == "/state" else None
        ):
            raise RunnerError(
                f"case {case_id} response {response_index} {path}: "
                f"expected same value as response {reference['response']} {reference.get('path', '')}, "
                f"got {actual!r} vs {reference_value!r}"
            )
        return

    if "equals" in assertion:
        expected = assertion["equals"]
        if semantic_value(actual) != semantic_value(expected):
            raise RunnerError(
                f"case {case_id} response {response_index} {path}: "
                f"expected {expected!r}, got {actual!r}"
            )
    if "contains" in assertion:
        expected = assertion["contains"]
        if not isinstance(actual, (list, dict, str)) or expected not in actual:
            raise RunnerError(
                f"case {case_id} response {response_index} {path}: "
                f"expected {expected!r} to be contained in {actual!r}"
            )
    if "not_contains" in assertion:
        unexpected = assertion["not_contains"]
        if isinstance(actual, (list, dict, str)) and unexpected in actual:
            raise RunnerError(
                f"case {case_id} response {response_index} {path}: "
                f"did not expect {unexpected!r} in {actual!r}"
            )
    if "length" in assertion:
        expected_length = assertion["length"]
        try:
            actual_length = len(actual)
        except TypeError as exc:
            raise RunnerError(
                f"case {case_id} response {response_index} {path}: value has no length"
            ) from exc
        if actual_length != expected_length:
            raise RunnerError(
                f"case {case_id} response {response_index} {path}: "
                f"expected length {expected_length}, got {actual_length}"
            )


def compare_engines(
    case_id: str,
    engine_responses: Mapping[str, Sequence[dict[str, Any]]],
) -> None:
    names = list(engine_responses)
    if len(names) < 2:
        return
    reference_name = names[0]
    reference = engine_responses[reference_name]
    for other_name in names[1:]:
        other = engine_responses[other_name]
        if len(other) != len(reference):
            raise RunnerError(
                f"case {case_id}: {other_name} returned {len(other)} responses, "
                f"{reference_name} returned {len(reference)}"
            )
        for index, (reference_response, other_response) in enumerate(zip(reference, other)):
            expected = semantic_response(reference_response)
            actual = semantic_response(other_response)
            if actual != expected:
                raise RunnerError(
                    f"case {case_id} response {index}: semantic mismatch between "
                    f"{reference_name} and {other_name}\n"
                    f"{reference_name}: {json.dumps(expected, sort_keys=True)}\n"
                    f"{other_name}: {json.dumps(actual, sort_keys=True)}"
                )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--case", action="append", dest="case_ids", default=[])
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--engine", action="append", type=parse_engine, default=[], metavar="NAME=COMMAND")
    parser.add_argument("--python", dest="python_command", metavar="COMMAND")
    parser.add_argument("--c", dest="c_command", metavar="COMMAND")
    parser.add_argument("--typescript", dest="typescript_command", metavar="COMMAND")
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    engines: list[tuple[str, list[str]]] = list(args.engine)
    for name, command in (
        ("python", args.python_command),
        ("c", args.c_command),
        ("typescript", args.typescript_command),
    ):
        if command is not None:
            try:
                engines.append((name, parse_command(command)))
            except argparse.ArgumentTypeError as exc:
                parser.error(f"--{name}: {exc}")
    if not engines:
        parser.error("supply at least one --engine NAME=COMMAND or language-specific command")
    names = [name for name, _ in engines]
    if len(names) != len(set(names)):
        parser.error("engine names must be unique")
    args.engines = engines
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        cases = load_corpus(args.cases)
        selected = set(args.case_ids)
        unknown = selected - {case["id"] for case in cases}
        if unknown:
            raise RunnerError(f"unknown case ids: {', '.join(sorted(unknown))}")
        if selected:
            cases = [case for case in cases if case["id"] in selected]

        passed = 0
        for case in cases:
            responses_by_engine: dict[str, Sequence[dict[str, Any]]] = {}
            diagnostics: dict[str, str] = {}
            for name, command in args.engines:
                session = EngineSession(name, command, args.timeout)
                try:
                    responses = session.send_case(case)
                finally:
                    diagnostics[name] = session.close()
                responses_by_engine[name] = responses
                for assertion in case.get("assertions", []):
                    check_assertion(case["id"], assertion, responses)
            compare_engines(case["id"], responses_by_engine)
            passed += 1
            print(f"PASS {case['id']} ({', '.join(responses_by_engine)})")
            for name, diagnostic in diagnostics.items():
                if diagnostic.strip():
                    print(f"  {name} stderr: {diagnostic.strip()!r}")
        print(f"{passed} shared conformance cases passed")
        return 0
    except RunnerError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
