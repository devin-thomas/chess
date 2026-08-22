# Benchmark interpretation

The generated report is comparative, not an absolute ranking. All engines are run on the same host with the same protocol requests, seeds, and maximum ply limits.

- Processing time is wall-clock time for the child process and is reported per game and as an amortized seconds-per-played-ply value. Both include process startup and protocol I/O.
- Memory is the child process maximum resident set size. The benchmark normalizes macOS and Linux `ru_maxrss` units to KiB.
- Lines of code count nonblank, non-comment source lines in the implementation files. Generated reports and tests are excluded from the implementation count.
- Randomness quality samples the root position's uniformly selected legal moves. The report includes Shannon entropy, expected entropy, chi-square goodness-of-fit, maximum absolute frequency deviation, and lag-1 correlation. These statistics evaluate the PRNG and selector, not chess strength or move quality.

The engines intentionally share the SplitMix64 algorithm. A quality difference therefore indicates a translation or numeric-semantics defect rather than a different RNG design. Rust is compiled as an optimized standalone binary alongside the other implementations.
