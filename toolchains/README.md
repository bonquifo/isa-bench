# Real toolchain lane

This directory is the reproducible, functional-validation toolchain boundary.
It makes no timing, energy, or performance claim.

## Pinned inputs and images

`manifest.json` is authoritative. Every downloaded archive has an official
version, HTTPS release URL, SHA-256, and license. The Debian base is pinned by
multi-platform index digest and records the linux/amd64 manifest digest.
Production image references are versioned; `latest` is rejected.

- `isa-sim/codegen:23.1.0`: checksum-verified official LLVM 23.1 binary.
- `isa-sim/qemu-user:11.1.0`: QEMU 11.1 built from verified source with only
  AArch64, RV64, MIPS o32, PPC64LE, and SPARC linux-user targets.
- `isa-sim/sparc-linker:2.40-2`: pinned GNU ELF32 SPARC linker (LLD has no
  `elf32_sparc` emulation).
- `isa-sim/wasi:33.0-48.0.1`: WASI SDK 33 and Wasmtime 48.0.1.
- `isa-sim/mos:23.0.1`: llvm-mos SDK 23.0.1.
- `Dockerfile.builder`: exact LLVM/QEMU source builder, restricted to the seven
  requested LLVM backends and five QEMU linux-user targets.

All runtime images use UID/GID 65532. The server adds no network, read-only
root, dropped capabilities, no-new-privileges, PID/CPU/memory/tmpfs/file/output
limits, argv execution without a shell, and bounded cancellation/timeout.

## Commands

```sh
npm run toolchains:build
npm run toolchains:build:qemu
npm run toolchains:doctor
npm run toolchains:test
npm run verify:toolchains
```

Reports are written below `.isa-bench-data/toolchains/`; smoke objects are
content-hashed below `.isa-bench-data/toolchain-smoke/`. Checked-in
`images.lock.json` records observed image IDs/digests, self-tests, generation
time, and the source manifest hash.

## Capability meaning

Capabilities are discovered from image self-tests. A target is never promoted
because its name appears in a manifest alone.

- `execute`: the exact submitted workload was linked and its versioned result
  frame was parsed and independently compared.
- `codegen-only`: object generation, ELF/Wasm identity, and disassembly checks
  passed, but no audited executor/runtime exists for that exact workload.
- `unsupported`: required image/tool/self-test or compatibility check failed.

The pinned lane executes x86-64 natively, AArch64/RV64/MIPS o32/PPC64LE/SPARC
V8 through the source-built QEMU image, and WASI through Wasmtime. Linux uses
freestanding syscall adapters with no target libc. SPARC objects must be ELF32
big-endian EM_SPARC and pass a conservative V8 instruction scan. The llvm-mos
SDK's `mos-sim` executes separate 64 KiB MMIO arithmetic, memory, and edge
probes; arbitrary canonical LLVM programs remain `codegen-only` because a
verified generic-to-llvm-mos lowering is not present. The normal 2 MiB guest is
`unsupported` on MOS. A per-target failure does not invalidate other results.

## Reproducibility

Builds use `SOURCE_DATE_EPOCH=1787616000`, locale/time-zone normalization, and
fixed source archives. For source-builder reproducibility, export `/out/llvm`
or `/out/qemu` twice and compare sorted per-file SHA-256 manifests. OCI image
config JSON is excluded because BuildKit creation/provenance metadata may
differ; installed tool bytes and smoke objects are not excluded.
