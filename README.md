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

RISC-V-style, AArch64-like, x86-64-style, MIPS32-like, PowerPC/POWER-like,
SPARC V8-like, WebAssembly-like, and MOS 6502-style.

These are **pseudo-backends**: models of how each architecture's instruction
set shapes a program, not real assemblers. Their output is a modeled lowering
stream, not executable machine code or vendor disassembly. The RISC-V-style
backend includes floating-point pseudo-operations and is not an RV32IM
implementation.

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
src/engine/   ISA backends, C compiler, IR, timing models, cache/memory
src/lanes/    The two model lanes and their navigation
src/ui/       Report rendering, saved runs, exports
src/index.css All styling
desktop/      Electron shell
```
