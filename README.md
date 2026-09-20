# ISA Bench

ISA Bench is a multi-lane evidence workbench. The browser always provides two
controlled educational models over eight ISA-inspired lowering targets. A local
loopback backend can add functional toolchain validation and capability-gated
research-simulator jobs. The empirical calibration lab is fully implemented and
remains empty until signed evidence is imported from an enrolled runner.

The project contains no fabricated physical measurements and makes no hardware
performance predictions from the analytical models. Experiment kinds do not share
rankings. Exact support tiers, comparison-group rules, and the empty-lab
statement live in [docs/PROTOCOL.md](docs/PROTOCOL.md). The sandbox, signature,
and import boundary is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

The analytical targets are RISC-V-style, AArch64-like, x86-64-style, MIPS32-like,
PowerPC/POWER-like, SPARC V8-like, WebAssembly-like, and MOS 6502-style
pseudo-backends. Their in-browser output is a modeled lowering stream, not
executable disassembly or a vendor binary. The RISC-V-style backend includes
floating-point pseudo-operations and is not an RV32IM implementation.

## Desktop app

The supported end-user form is a standalone windowed application. It still
renders the existing workbench inside an embedded Chromium window and starts
the loopback backend itself. That is not a rewrite in native OS widgets; it is
a packaged program that does not require a browser or `npm run dev`.

Build installers from this repository:

```bash
npm install
npm run desktop:pack
```

`desktop:pack` builds the current host. Target-specific commands:

```bash
npm run desktop:pack:win     # NSIS .exe
npm run desktop:pack:linux   # AppImage (easiest) and .rpm
npm run desktop:pack:mac     # .dmg and .zip
```

Artifacts land in `release/`. A Windows host can produce the `.exe`. A Linux
host can produce AppImage/RPM. A macOS host can produce the `.dmg`. The
installers do not include Docker images; toolchain and research-simulator lanes
stay capability-gated until those images exist on the machine. Empirical and
calibrated production sets stay empty until signed evidence is imported.

Development of the desktop shell:

```bash
npm run desktop:dev
```

## Run it in a browser

```bash
npm install
npm test
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`). The browser
path remains a development fallback.

## Local backend

Node 22.5 or newer is required because the backend uses Node's built-in `node:sqlite`.
The normal browser-only build remains fully functional. In development, start both
Vite and the loopback backend with:

```bash
npm run dev:all
```

The browser probes `/api/health` in `auto` mode, runs the existing analytical
in-order comparison in an isolated worker when the backend is healthy, and
falls back to the in-browser model if it is not. Set
`VITE_ISA_BACKEND_MODE=browser` to force browser execution,
`VITE_ISA_BACKEND_MODE=backend` to require the service, or
`VITE_ISA_BACKEND_URL=http://127.0.0.1:4317` when not using Vite's proxy.

The service binds to `127.0.0.1:4317` by default. It rejects non-loopback bind
addresses unless the CLI receives the explicit `--allow-remote` flag, rejects
non-loopback browser origins, and requires a short-lived session token on
mutating requests. Persistent SQLite job state and content-addressed artifacts
live under the gitignored `.isa-bench-data/`. Running jobs are marked
`failed/interrupted` after restart.

Useful commands:

```bash
npm run server
npm run cli -- doctor
npm run cli -- health
npm run cli -- submit input.json
npm run cli -- submit input.json --lane analytical-ooo
npm run cli -- watch JOB_ID
npm run cli -- cancel JOB_ID
npm run cli -- run input.json
npm run cli -- artifact download SHA256 result.json
npm run server:test
npm run verify:backend
```

## Experiment lanes

`npm run dev` opens the multi-lane workbench. Server-required lanes stay
honestly unavailable until `npm run dev:all` or `npm run server` is healthy.

| Lane | Availability | What a result means |
| --- | --- | --- |
| Controlled in-order | browser or backend | deterministic educational timing model |
| Controlled detailed OoO | browser | decoded-operation model over the same lowering streams |
| Real toolchain validation | backend + pinned images | functional result-frame agreement, not performance |
| Research simulators | backend + locked images | gem5 O3 SE (x86-64, AArch64, RV64) and llvm-mca (those plus MIPS o32) on eligible native artifacts, ROI-scoped; ChampSim is import-only |
| Empirical calibration lab | backend | admin of runners, leases, quarantine, and empty production tables |
| Calibrated predictions | backend | apply an approved fit; none exist until signed evidence is imported |

Observed execute/codegen-only/unsupported tiers are recorded in
`toolchains/capabilities.lock.json`, `toolchains/native-capabilities.lock.json`,
and `external/capabilities.lock.json`. `npm run native-corpus:build` produces
the smoke index, which covers only `x86_64-linux`, `wasm32-wasip1`, and
`mos-sim` (except `fp_sum` on MOS); with only that index, gem5 and llvm-mca are
`unsupported` on the QEMU-backed Linux targets because no eligible artifact
exists there, not because the engines cannot run them.
`npm run native-corpus:build -- --full` builds all eight targets, after which
`npm run external:test` re-probes and promotes gem5 on AArch64/RV64 and
llvm-mca on those plus MIPS o32. Rebuilding the corpus changes the artifact
index hash that `external/capabilities.lock.json` binds to, so the lock must
be regenerated afterwards.

The Docker executor uses an image allowlist by immutable ID, argv execution
without a shell, no network, non-root users, a read-only root, dropped
capabilities, no-new-privileges, and bounded process, memory, CPU, temporary
storage, output, file, and execution time. WSL is only a trusted-development
probe; untrusted programs are never executed directly on the host.

Pinned toolchain assets and builders are documented in `toolchains/README.md`.
External adapter locks and the ChampSim `microtrace-v1` contract are in
`external/README.md`. Toolchain results are functional evidence only.

## Measurement contract

- Shared model profile is the controlled comparison: every target receives the same model parameters.
- Named illustrative presets are parameter presets on the same in-order model. They are not CPU emulation or measurement, and cross-preset rankings are not controlled ISA comparisons.
- At the start of model cycle `c`, completions scheduled for `c` run in issue order, then issue reads operands. An operation with execution/result latency `L >= 1` completes at `c + L`; results, loads, and stores become visible at completion. Redirect, hierarchy, and coherence values are separate extra penalties and may be zero.
- RAW/WAW/WAR and hidden resources are scoreboarded. Each thread permits one outstanding memory operation. HALT, BARRIER, CALL, ICALL, and RET drain older operations. Termination drains retained completion events.
- Arbitration is core order, round-robin thread order, then program order. Fetch-byte and issue-width limits, functional ports, forwarding, and class latencies are deterministic.
- Prediction applies only to conditional BEQ/BNE/BLT/BGE. Direct jumps and calls are direction-known, indirect calls pay a fixed redirect, and returns use a bounded perfect RAS.
- L1/L2/L3 are set-associative line caches. Accesses split by line; private L1D ownership uses deterministic coherence transfers and invalidations. Shared L3 and modeled DRAM channels handle lower-level traffic.
- All configured cache levels, including disabled zero-capacity levels, use one canonical line size so fetch, data ranges, pending requests, and coherence share one address domain.
- Fetch assembly is sequential after required instruction-line fills. An `N`-byte first modeled operation occupies `ceil(N / fetchWidth)` fetch cycles and may issue on the last assembly cycle; line statistics and fetched bytes are counted once.
- Nominal model energy is an uncalibrated event model plus integrated core residency. Its uncertainty is not quantified.
- The SPARC V8-like pseudo-backend adds a fixed one-model-cycle bubble after every control transfer. It does not execute a delay-slot instruction.

The separately versioned `ooo-1.2.0` lane consumes the existing ISA-inspired
`MachInst` streams as `DecodedOp` input; it does not decode or predict real
binary execution. It models per-thread RAT/AMT/PRF/free-list state, bounded
ROB/classed reservation stations/LSQ/store buffer/checkpoints, oldest-ready
issue on shared per-core functional units, in-order precise retirement,
conditional speculation and squash, store-to-load forwarding, and committed
stores. Its fixed cycle phase order is: memory/FU completion; branch
resolution/squash; store-buffer drain; retirement; barrier release; issue;
dispatch/rename; decode; fetch; residency accounting. OoO energy uses the
independent `ooo-energy-1.2.0-uncalibrated` event model. Custom parallel IR uses
the ISA-independent `ir-reference-2.0.0` fixed-round-robin reference executor.

OoO stage widths are uops per model cycle. An operation is atomic at every
stage and, when wider than that stage, monopolizes it for
`ceil(operation uops / stage width)` cycles. Reservation-station occupancy ends
when issue completes; ROB occupancy ends at retirement. Store buffers are
per-thread and expose only their FIFO head through one deterministic global
drain grant per cycle. `unknownStoreStalls` and `overlapStalls` count blocked
load issue attempts, `nonaliasBypasses` counts loads that issue past at least
one known nonaliasing older store, `forwardedBytes` counts overlaid load bytes,
and head-block values count thread-cycle retirement attempts. FU utilization is
occupied physical-FU slots divided by physical-FU slots × cores × model cycles.

Every result carries independent schema, model, frontend, backend, profile, and energy versions. JSON export is the canonical versioned result envelope and includes rerun input, complete resolved profiles, provenance, and the disclaimer. Canonical JSON uses explicit IEEE-754 tags for NaN, positive/negative infinity, and negative zero so these values round-trip and fingerprint distinctly; ordinary finite values remain ordinary JSON numbers. CSV is only a qualified flattened summary.

## Metrics

- `model cycles`: global deterministic timing-model cycles.
- `dynamic modeled ops`: completed modeled operations after termination drains all retained completion events.
- `aggregate modeled ops/cycle = completed modeled operations / global model cycles`.
- `model cycles/aggregate op = global model cycles / completed modeled operations`.
- `modeled elapsed time = model cycles / profile clock parameter`; this is not stopwatch time.
- `modeled stream bytes`: bytes assigned by the pseudo-backend lowering model; not binary size.
- `nominal model energy (uncalibrated)`: event and residency estimate in model nJ; not measured energy.
- `cores that issued`: physical model cores that issued at least one operation. Average active cores integrates residency over model cycles.
- Cache miss, branch, spill, origin, and stall counters refer only to this model.

Rankings are described as ranked lowest or highest under this model.

## Reference scope

Built-in workloads have an independent host expected-value check and an IR-interpreter reference. Custom IR uses the IR interpreter. Custom C checks the generated IR and all selected pseudo-backends against the Guest C lowering reference; this does not validate ISO C. Return value and captured stdout are checked. Full memory is not generally an observable. Integer results must be exact signed i32 values without truncation. Binary64 results use exact ordered-operation observables: NaN matches NaN, and every other value uses exact identity, including infinity signs and signed zero. Any reference mismatch rejects the run.

Requested and effective parameters are distinct. Built-ins report effective N and a clamped-from note when needed, and only report a seed when that workload uses one. Fixed canned C reports neither N nor seed. Parallel custom programs report the requested worker cap and effective active workers.

## Guest C v1.4 subset

Guest C v1.4 supports signed 8-bit `char`, signed wrapping 32-bit `int`, IEEE-754 binary64 `double`, pointers, arrays, structs, unions, enums, typedefs, initializers, control flow, calls/function pointers, bounded software stacks, and deterministic guest helpers including captured printf-style output. Its runtime entry point must be exactly `int main(void)`, with `double main(void)` as the sole extension when an IEEE-754 result (including NaN, infinity, or signed zero) must remain observable; all other entry signatures and other double function signatures are rejected. Static objects and interned literals are checked after lowering and cannot overlap the heap. The scalar categories `unsigned`, `short`, `long`, `long double`, `float`, `_Bool`/`bool`, and user-defined variadics are rejected. It uses bounded 32-bit guest addresses, bounded heap/stdout regions, 4 KiB worker stacks, at most 4096 call frames and 256 modeled hardware threads.

It has no operating system, files, sockets, signals, dynamic linking, host ABI, undefined-behavior compatibility, or ISO C conformance claim.

## Model limits

Both analytical models are intentionally simplified. The OoO lane models
timing over pseudo-backend decoded operations, not real instruction bytes,
vendor frontends, value prediction, memory-dependence prediction, speculative
stores, microcode, or calibrated power. Neither lane models operating systems,
devices, GPUs, thermal behavior, voltage/frequency control, physical
interconnects, or process variation. Preset names identify illustrative
parameter bundles, not faithful implementations of products.

## Custom IR

```text
imm r0, 0
imm r1, 0
imm r2, 128
loop:
  bge r0, r2, done
  add r1, r1, r0
  addi r0, r0, 1
  br loop
done:
  halt r1
```

Memory ops: `ldw r1, 0(r0)`, `stw r1, 0(r2)`, scaled `ldw r1, 0(r0,r3,4)`. Data: `.data 4096` then `.word 1 2 3`.

## Verification

Default verification:

```bash
npm run typecheck
npm test
npm run build
npm run lint
```

`npm test` is the fast default suite and deliberately excludes `*.deep.test.ts`. It checks workload references, all eight pseudo-backends, timing/cache/predictor behavior, save migration and validation, canonical JSON, CSV escaping, report vocabulary, and metadata.

Opt-in deep verification runs the seeded random-IR, all-target C fixture, parallel-profile, determinism, replay, and edge-program matrices:

```bash
npm run test:deep
```

To run the local aggregate gate (typecheck, lint, build, default tests, deep
tests, backend, OoO/memory tests, and contracts):

```bash
npm run verify
```

Lane-specific gates:

```bash
npm run verify:ooo
npm run verify:backend
npm run verify:empirical
npm run verify:calibration
npm run verify:external
npm run verify:native-corpus
npm run verify:toolchains
```

`npm run verify:all` adds the empirical/helper, native-corpus, external, and
toolchain container gates. Those commands require the pinned Docker images and
do not fabricate a passing tier when an image or artifact is absent.

Production and test TypeScript projects use `strict: true`; tests and `src/verify` helpers are included in project-reference typechecking. `noUncheckedIndexedAccess` remains future hardening because enabling it would require broad unrelated indexing changes and is not part of the current correctness claim.

Saved-run v2 entries contain the complete result, actual fixed-C effective source, and resolved per-target hardware-profile snapshots. RESTORE arms those immutable snapshots for exact replay instead of consulting current profile or preset catalogs; changing a hardware control deliberately clears the replay snapshot. Current entries also restore requested parameters, selected targets, mode, and custom overlays before opening the archived report. Legacy v1 entries migrate as viewable, explicitly non-rerunnable archives.
