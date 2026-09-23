# ISA Bench

A desktop app that runs the same program across eight instruction-set
architectures and shows you how each one's modeled timing compares.

Write C, pick your ISAs, hit **RUN MODEL**. Everything runs locally inside the
app — no server, no Docker, no network, no account.

## Install

Download the installer for your platform from `release/` and run it:

| Platform | Artifact |
| --- | --- |
| Windows | `ISA Bench-Setup-<version>-win-x64.exe`, or the `-Portable-` build for no install |
| Linux | `ISA Bench-<version>-linux-x86_64.AppImage`, or the `.tar.gz` |
| macOS | `ISA Bench-<version>-mac.dmg` |

To build an installer yourself:

```bash
npm install
npm run desktop:pack         # current platform
npm run desktop:pack:win     # NSIS .exe + portable
npm run desktop:pack:linux   # AppImage + tar.gz
npm run desktop:pack:mac     # .dmg + .zip
```

Artifacts land in `release/`.

**Build each platform on that platform.** This is not a preference:

- A Linux `tar.gz` built on Windows unpacks **without the executable bit** on
  `isa-bench` and `chrome-sandbox`, so it will not start, and AppImage needs
  symlinks Windows withholds unless Developer Mode is on.
- macOS `.dmg` packaging needs macOS tooling and cannot run elsewhere at all.

Two supported ways to get all three:

1. **CI** — [`.github/workflows/release.yml`](.github/workflows/release.yml)
   builds every platform on its own runner and attaches the results to a draft
   GitHub release when you push a `v*` tag. It also asserts the Linux tarball
   kept its executable bits.
2. **Linux from a Windows checkout via WSL**:

   ```bash
   wsl -d Ubuntu -- bash scripts/pack-linux-wsl.sh
   ```

   This copies the sources into the Linux filesystem, installs there, builds,
   and copies the artifacts back into `release/`. It needs Node 22+ inside the
   distro and prints how to install one, without root, if none is found.

## What it does

You give it a program, it compiles that program down to eight different
ISA-inspired backends, runs each one through a deterministic timing model, and
shows you the cycle counts, cache behavior, branch statistics, and instruction
mix side by side.

Programs can come from three places:

- **Built-in workloads** — `int_sum`, `dot_product`, `saxpy`, `memcpy`,
  `matmul`, `insertion_sort`, `binary_search`, `sieve`, `checksum`,
  `pointer_chase`, `fir`, `fp_sum`, each with an adjustable size `N` and seed
- **Your own C** — written in the editor, compiled by the built-in Guest C
  compiler
- **Custom IR** — the project's own intermediate representation, if you want to
  control the instruction stream directly

## The eight targets

RISC-V, AArch64, x86-64, MIPS32, POWER, SPARC V8, WebAssembly and the MOS
6502 — and each can be run two ways.

**Real instruction sets.** For the fourteen canned C programs, every target
runs the program compiled by clang for that architecture — **RV64GC**,
**AArch64**, **x86-64**, **MIPS32**, **POWER**, **SPARC V8**,
**WebAssembly** and the **MOS 6502** — linked against a real C library and
executed by an interpreter verified against a reference. This is the
default for those programs, because it is the comparison the app exists to
make: the instruction counts, encodings and register pressure are the
architectures' own, not a caricature of them.

**Model lowering.** Everything else — the built-in kernels, your own C and
custom IR — runs on **pseudo-backends**: models of how each architecture's
instruction set shapes a program, not real assemblers. Their output is a
modeled lowering stream, not executable machine code or vendor
disassembly. They are there because the app cannot compile at runtime:
the real binaries were built ahead of time, and only for the canned
programs. A canned program can be switched to the lowering too, to see the
difference.

A comparison table is always one or the other and says which. Real rows
and lowered rows side by side would invite reading both as the same kind
of number.

Every real row must return the same value and print the same output as the
IR reference, or the run is rejected. The one exception is stated rather
than excused: the 6502's C `int` is sixteen bits, so where a program's
answer does not fit in one, it computes a different value and is right to.
One program (`struct`) cannot be built for it at all, for the same reason,
and the report says so.

## How each real target is verified

For RV64GC, AArch64, x86-64, MIPS32, POWER and SPARC V8 the check is
instruction by instruction — every register before every instruction —
against `qemu-riscv64`, `qemu-aarch64`, `qemu-mipsel`, `qemu-ppc64le`,
`qemu-sparc` and, for x86-64, the host processor itself, then the final
state byte for byte, then whole programs against the reference's output.

Two are verified differently and say so, because for both of them no
reference exists that can be stepped alongside.

The 6502 is checked against 23,502 single-instruction cases recorded from
hardware — every documented opcode, from arbitrary machine state — and
then on whole programs against `mos-sim`. That is stronger than lockstep
for one instruction and weaker for a sequence, and the app states the
pair rather than borrowing the other targets' sentence.

WebAssembly is compiled to machine code by every engine that runs it, so
there is no operand stack left to step through. Instead every one of its
operations is compared against a real engine on every edge value of its
operand types — both zeros, both infinities, both signs of NaN — and then
whole modules are compared on *all* of linear memory, byte for byte,
rather than on a chosen set of registers. The app's fourteen corpus
programs are checked against `wasmtime`, a second engine from a different
vendor.

What is real is the instruction stream and the program's own output.
Everything else — cycles, cache behavior, energy — is the same
deterministic model either way. **Nothing anywhere in this app is measured
on hardware.**

The libraries differ, and the app names them. Most targets link musl;
SPARC links picolibc, because musl has no SPARC port; WebAssembly links
wasi-libc and the 6502 llvm-mos's own. Instructions inside `printf` are
that library's, so a difference there is partly a difference of library.

An instruction a real backend does not implement is refused by name and
address; it is never executed as an approximation. On the 6502 that
extends to the 105 opcodes the architecture leaves undefined, and to the
simulator's cycle counter, which this app will not answer because it has
no measured number to give. On WebAssembly it extends to the reference
types, SIMD and threads, none of which a C toolchain emits.

## The two models

**In-order** is the default. A deterministic scoreboarded in-order pipeline with
configurable issue width, functional units, cache hierarchy, and branch
prediction.

**Detailed out-of-order** consumes the same lowering streams as decoded
operations and models per-thread register renaming, a bounded reorder buffer,
classed reservation stations, load/store queues, speculation and squash,
store-to-load forwarding, and in-order precise retirement.

Both are educational models. They produce *model cycles*, not nanoseconds, and
make no claim about how fast real silicon would run your code.

## Guest C subset

The built-in compiler implements **Guest C v1.4**, a deliberately small subset.
It supports signed 8-bit `char`, signed wrapping 32-bit `int`, IEEE-754
binary64 `double`, pointers, arrays, structs, unions, enums, typedefs,
initializers, control flow, calls and function pointers, bounded software
stacks, and deterministic helpers including captured `printf`-style output.

The entry point must be exactly `int main(void)`, or `double main(void)` when an
IEEE-754 result (NaN, infinity, signed zero) needs to stay observable.

Rejected: `unsigned`, `short`, `long`, `long double`, `float`, `_Bool`/`bool`,
and user-defined variadics. There is no operating system, no files, no sockets,
no signals, no dynamic linking, no host ABI, and no ISO C conformance claim.

Every run is checked against an independent reference interpreter. Integer
results must match exactly as signed 32-bit values; binary64 results must match
exactly including NaN, infinity signs, and signed zero. Any mismatch rejects the
run rather than reporting a number.

## Metrics

- **model cycles** — deterministic timing-model cycles
- **dynamic modeled ops** — completed modeled operations after termination
- **aggregate modeled ops/cycle** — completed operations ÷ model cycles
- **modeled elapsed time** — model cycles ÷ the profile's clock parameter; this
  is not stopwatch time
- **modeled stream bytes** — bytes assigned by the lowering model, not binary size
- **nominal model energy (uncalibrated)** — an event and residency estimate in
  model nJ, not measured energy

Cache miss, branch, spill, origin, and stall counters refer only to this model.
Rankings are described as ranked lowest or highest *under this model*.

## Model limits

Both models are intentionally simplified. Neither models operating systems,
devices, GPUs, thermal behavior, voltage/frequency scaling, physical
interconnects, or process variation. The OoO model works over pseudo-backend
decoded operations, not real instruction bytes, and does not model vendor
frontends, value prediction, memory-dependence prediction, speculative stores,
or microcode.

Named hardware presets are illustrative parameter bundles, not faithful
reproductions of real products. Cross-preset comparisons are not controlled ISA
comparisons — only the shared model profile gives every target identical
parameters.

## Development

```bash
npm install
npm run dev          # Vite dev server at http://localhost:5173
npm run desktop:dev  # Electron shell against the dev server
npm test             # full test suite
npm run verify       # typecheck + lint + test + build
```

Source layout:

```text
src/engine/   Pseudo-backends, C compiler, IR, timing models, cache/memory
src/isa/      Real instruction-set interpreters and their differential suite
src/lanes/    The three lanes and their navigation
src/ui/       Report rendering, saved runs, exports
src/index.css All styling
desktop/      Electron shell
```
