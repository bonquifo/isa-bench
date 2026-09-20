# Experiment protocol and support tiers

This document is the scientific contract for ISA Bench experiment kinds.
Comparison-group keys, metric domains, and claim classes are independently
versioned in `@isa-sim/contracts`. Two results may share a ranking only when
their comparison-group key matches exactly. Model cycles, external-simulator
cycles, static llvm-mca cycles, and measured nanoseconds are distinct domains
and are never normalized together.

Empirical and calibrated production result sets are empty until signed evidence
is imported from an enrolled runner. No physical measurements are fabricated.

## Experiment kinds

| Kind | Claim class | Evidence class | Primary domain |
| --- | --- | --- | --- |
| `analytical-inorder` | analytical-estimate | model-output | `analytical-model-cycles` |
| `analytical-ooo` | analytical-estimate | model-output | `analytical-model-cycles` |
| `toolchain-validation` | functional-toolchain-validation | generated-code | `functional-validation-status` |
| `gem5` | external-simulation | external-simulator-output | `external-simulator-cycles` |
| `llvm-mca` | static-throughput-estimate | external-simulator-output | `static-throughput-cycles-per-instruction` |
| `champsim` | external-simulation | external-simulator-output | `external-simulator-cycles` |
| `empirical-measurement` | empirical-observation | raw-measurement / aggregated-measurement | `physical-time-ns` or `physical-energy-j` |
| `calibrated-prediction` | calibrated-prediction | calibration-fit | bound to the frozen dataset domain |

## Capability tiers

A target or engine is never promoted because its name appears in a manifest.

- `execute`: an exact observed probe passed for that target, workload, artifact, and executor.
- `codegen-only`: object, identity, or disassembly checks passed, but no audited executor exists for that exact workload.
- `unsupported`: the required image, artifact, mapping, producer, or probe is missing or failed.

Unsupported sensors, adapters, and traces return `unsupported`. They never emit a zero that could be mistaken for a measurement.

## Observed support matrix

These tiers are the locked observations on this machine, not aspirations.

### Controlled analytical models

Both in-order and decoded-operation out-of-order models run for all eight
ISA-inspired lowering targets: RISC-V-style, AArch64-like, x86-64-style,
MIPS32-like, PowerPC/POWER-like, SPARC V8-like, WebAssembly-like, and MOS
6502-style. They consume the project's IR or Guest C v1.4 lowering. They do
not decode vendor binaries and do not predict physical hardware.

### Real-toolchain functional validation

Pinned images: LLVM 23.1.0, QEMU 11.1 linux-user, WASI SDK 33 + Wasmtime
48.0.1, llvm-mos SDK 23.0.1, GNU ELF32 SPARC linker 2.40-2.

| Target | Observed tier | Executor |
| --- | --- | --- |
| `x86_64-linux` | execute | freestanding static binary in the hardened codegen container |
| `aarch64-linux` | execute | `qemu-aarch64` |
| `riscv64-linux` | execute | `qemu-riscv64` |
| `mipsel-o32` | execute | `qemu-mipsel` |
| `powerpc64le-elfv2` | execute | `qemu-ppc64le` |
| `sparc-v8` | execute | `qemu-sparc` after ELF32 SPARC link |
| `wasm32-wasip1` | execute | Wasmtime with fuel and no inherited filesystem |
| `mos-sim` | execute for MMIO arithmetic/memory/edge probes; codegen-only for arbitrary canonical LLVM | `mos-sim` 64 KiB path |

Toolchain results are functional-agreement evidence only. Wall-clock durations
recorded during Docker startup are diagnostics and carry no timing claim.

### Native benchmark corpus

<!-- native-corpus:begin -->
Generated from the `full` index of corpus `1.1.0` by `npm run docs:external`; counts are this machine's observed eligibility (two clean builds + independent result-frame check).

| Target | Eligible artifacts | Notes |
| --- | --- | --- |
| `x86_64-linux` | 12 / 12 workloads | all workloads measurement-eligible |
| `aarch64-linux` | 12 / 12 workloads | all workloads measurement-eligible |
| `riscv64-linux` | 12 / 12 workloads | all workloads measurement-eligible |
| `mipsel-o32` | 12 / 12 workloads | all workloads measurement-eligible |
| `powerpc64le-elfv2` | 12 / 12 workloads | all workloads measurement-eligible |
| `sparc-v8` | 12 / 12 workloads | all workloads measurement-eligible |
| `wasm32-wasip1` | 12 / 12 workloads | all workloads measurement-eligible |
| `mos-sim` | 11 / 12 workloads | `fp_sum`: llvm-mos target has no auditable binary64 ABI/runtime within the 64 KiB simulator contract |
<!-- native-corpus:end -->

A binary becomes measurement-eligible only after two clean builds with
identical hashes and an independently matched result frame.

### External research simulators

Pinned: gem5 25.1.0.0, llvm-mca from LLVM 23.1.0, ChampSim 2026-04.

<!-- external-capabilities:begin -->
Generated from `external/capabilities.lock.json` by `npm run docs:external`; the lock is authoritative and reasons are abbreviated.

| Engine | Targets | Observed tier | Reason |
| --- | --- | --- | --- |
| gem5 | `x86_64-linux` | execute | exact execution-driven x86_64 O3 syscall-emulation smoke passed with eligible static native corpus binary, validated em… |
| gem5 | `aarch64-linux` | execute | exact execution-driven aarch64 O3 syscall-emulation smoke passed with eligible static native corpus binary, validated e… |
| gem5 | `riscv64-linux` | execute | exact execution-driven riscv64 O3 syscall-emulation smoke passed with eligible static native corpus binary, validated e… |
| gem5 | `mipsel-o32` | unsupported | gem5 target mipsel-o32 has no validated ISA-aware configuration |
| gem5 | `powerpc64le-elfv2` | unsupported | gem5 target powerpc64le-elfv2 has no validated ISA-aware configuration |
| gem5 | `sparc-v8` | unsupported | gem5 target sparc-v8 has no validated ISA-aware configuration |
| gem5 | `wasm32-wasip1`, `mos-sim` | unsupported | WASM and MOS are explicitly unsupported by the gem5 adapter |
| llvm-mca | `x86_64-linux`, `aarch64-linux`, `riscv64-linux`, `mipsel-o32` | execute | assembler-compatible native ROI fully parsed with a valid LLVM 23.1 scheduling model and required JSON fields |
| llvm-mca | `powerpc64le-elfv2` | unsupported | native ROI disassembly was skipped or elided |
| llvm-mca | `sparc-v8` | unsupported | llvm-mca failed: error: unable to find instruction-level scheduling information for target triple 'sparc-unknown-linux-… |
| llvm-mca | `wasm32-wasip1`, `mos-sim` | unsupported | WASM and MOS are explicitly unsupported by the llvm-mca adapter |
| champsim | `x86_64-linux` | unsupported | import-only: no locked first-party dynamic x86 trace producer is allowlisted; fabricated direct input_instr records are… |
| champsim | `aarch64-linux`, `riscv64-linux`, `mipsel-o32`, `powerpc64le-elfv2`, `sparc-v8`, `wasm32-wasip1`, `mos-sim` | unsupported | no exact validated microtrace-v1 producer/register mapping exists for this ISA |
<!-- external-capabilities:end -->

The gem5 profile is an ISA-specific O3 CPU at 2 GHz, 32 KiB two-way L1I/L1D,
256 KiB eight-way L2, and `SimpleMemory` (30 ns, 512 MiB). It makes no DDR3
claim. Its statistics cover only the ROI: they are reset when the
`isa_bench_roi_begin` marker first commits and dumped when `isa_bench_roi_end`
first commits, so process start-up and result-frame emission are excluded, and
a run in which either marker never commits fails rather than reporting
whole-process numbers. llvm-mca is a static scheduling-model estimate, not
dynamic execution: it assumes every load hits and every branch is
straight-line, so each llvm-mca result carries a `staticModelRelevance` of
`high`, `low`, or `unknown` derived from the workload family, and memory- or
control-bound kernels are reported as `low`.
ChampSim accepts only a provenance-checked committed-path `microtrace-v1`
artifact pair and does not model wrong-path semantic execution.

### Empirical calibration lab

The runner, Rust measurement helper, signed lease protocol, quarantine import,
statistics, fitting, holdout, and applicability machinery are implemented.
Production tables for runners, jobs, imports, raw runs, summaries, datasets,
and calibrations are empty until a signed evidence bundle from an approved
runner is inspected and explicitly committed.

Synthetic fixtures are marked test-only and are rejected by production import.

## Comparison isolation

`buildComparisonGroupKey` binds experiment kind, model/adapter version,
workload semantic hash, artifact pipeline hash, ROI definition hash, profile
fingerprint, metric domain, and unit. A UI ranking is refused unless every
envelope in the group carries that same key and the complete metric
domain/unit signature.

## Replay and persistence

Analytical results fingerprint the complete rerun input, including resolved
profiles and effective source. Canonical JSON tags IEEE-754 NaN, infinities,
and signed zero. Empirical bundles are content-addressed and must match their
signed schedule, binary hash, lease, and nonce before they can leave
quarantine.
