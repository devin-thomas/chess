# Replay Cache Benchmark

The repository benchmark records seek-only timings for the same generated legal
replay with the reference controller and the full-history web cache. It does not
include replay-load/cache-build time, because scrubbing begins after the viewer
has loaded its artifact.

Capture command:

```sh
npm run benchmark:replay -- --json-out reports/replay-cache-benchmark.json
```

Captured on 2026-09-11:

| Field | Value |
| --- | --- |
| Runtime | Node `v24.18.0` |
| Device/runtime | macOS `darwin`, `arm64` |
| CPU | Apple M4 Pro |
| Browser | not applicable (Node host benchmark) |
| Replay length | 80 plies |
| Seek samples | 32 deterministic sampled plies |
| Uncached average | 43.602 ms |
| Cached average | 0.596 ms |

The JSON report is intentionally written under ignored `reports/`; rerun the
command on the target browser/device when collecting production measurements.
