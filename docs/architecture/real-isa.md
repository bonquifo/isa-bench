# Real instruction-set semantics

Written for engineers continuing this work on the remaining six targets.

This describes the interpreters that replace the pseudo-backend lowering, the
interface they present to the timing model, and what the remaining instruction
sets have to implement.

**Two are complete: RV64GC and AArch64.** For each, real C compiled by clang
and linked against a real libc executes against a real address space and
matches its qemu on architectural state for freestanding programs and on
output for whole programs. The second one is the evidence that the split in
section 1 was worth making: AArch64 needed a decoder, a semantics file and a
register map, and reused the address space, the ELF loader, the IEEE-754
layer, the Linux process emulation, the timing model, the fixture builder and
the conformance suite without changing any of them.

---

## 1. The decision: separate interpreters, shared substrate, execution split
from timing

Two choices were open: one interpreter over a normalised operation set, or one
interpreter per ISA sharing infrastructure. This project takes the second, and
separates execution from timing at the same time.

**The decisive argument is duplication, but not where it first appears.** The
engine has *two* fused execute-and-time models, not one: `simulate()` in
[src/engine/cpu.ts](../../src/engine/cpu.ts) and `simulateOoO()` in
[src/engine/ooo.ts](../../src/engine/ooo.ts) each carry an independent copy of
the semantics. Adding eight instruction sets to a fused design means sixteen
places a semantic bug can live. Split, it is eight plus two.

**A normalised operation set would have had to be a superset anyway.** SPARC
register windows are a register-file *topology* difference, not an opcode
difference. MIPS delay slots are a control-flow *semantics* difference. x86
sets flags as a side effect of nearly every instruction; RISC-V has none. A
shared operation set would carry all of that and couple the failures: a bug in
x86 flag lowering would sit in the same switch RV64 executes through.

What is genuinely shared is substrate, and that is where most of the risk was:
address space, ELF loading, syscall emulation, the exact IEEE-754 layer, and
trace emission. Those live in [src/isa/common/](../../src/isa/common/) and are
at 100% line coverage.

### What was reversed along the way

The initial plan was a hand-rolled 64-bit integer layer over `Int32Array`
lo/hi pairs, on the assumption that `BigInt` would be 10–50x slower. Measured,
it is **1.36x** on a dispatch-and-arithmetic microbenchmark (60 ms versus 44 ms
per 10M operations, identical checksums). At that price the pairs were not
worth it: they would have put `mulh`, `INT_MIN / -1` and shift amounts of 0, 32
and 63 into code that had to be right by hand. The register file is
`BigInt64Array`, and its assignment conversion gives wrapping at the
architectural width for free.

### Decoupling execution from timing: accepted, with one correction

A flat retired trace is not sufficient on its own. `simulateOoO()` speculates —
it counts `wrongPathOps` and `wrongPathBytes` — so it must fetch down
mispredicted paths that never retire, and a trace cannot supply those. The
interface is therefore **a static program image plus a streaming retired
trace**: correct-path facts come from the trace, wrong-path fetch is walked
statically over the image.

The trace streams in reusable chunks rather than materialising. A ten-million
instruction workload would otherwise be a few hundred megabytes of arrays
inside an Electron renderer.

### The accepted narrowing

Each SPMD worker would be interpreted independently and the timing model would
interleave their memory operations. That is sound only for programs that are
data-race-free between barriers. The current workloads are — striped
partitions, barrier, reduction — so nothing breaks today, but the fused model
is strictly more general and this trades that away. Recorded here as a
decision, not an accident. No SPMD workload runs through the real-ISA path yet.

---

## 2. What the timing model consumes

Defined in [src/isa/common/trace.ts](../../src/isa/common/trace.ts).

```ts
interface StaticInst {
  addr: bigint
  bytes: number            // real encoded length: 2 for a compressed instruction
  mnemonic: string
  cls: InstClass           // the engine's existing nine-entry timing class
  latencyClass: LatencyClass
  uops: number
  reads: readonly number[] // resolved architectural resource ids
  writes: readonly number[]
  control: ControlKind     // seq | cond | jump | call | ret | indirect | trap
  staticTarget: bigint     // byte address, or NO_ADDRESS
  readsMem: boolean
  writesMem: boolean
  accessWidth: number
  serializing: boolean
  origin: OperationOrigin
}

interface ProgramImage {
  at(addr: bigint): StaticInst            // throws on anything undecodable
  speculativeAt(addr: bigint): StaticInst | null   // null instead, for wrong paths
  entry: bigint
  naming: RegisterNaming
  codeBytes: number
}

interface RetireChunk {          // struct of arrays, reused between calls
  count: number
  pc: BigInt64Array
  nextPc: BigInt64Array          // covers indirect targets and delay slots
  effAddr: BigInt64Array
  accessWidth: Uint8Array
  taken: Uint8Array
}

interface Interpreter {
  image: ProgramImage
  run(into: RetireChunk): 'more' | 'exited'
  programCounter: bigint         // mid-run state, so lockstep can compare
  gpr(index: number): bigint     // before every instruction, not just at exit
  finalState(): ArchState
  stdout(): Uint8Array
  exitCode: number
  retired: number
}
```

Three properties matter:

- **`reads` and `writes` are resolved architectural resource ids** in a flat
  per-ISA space. Resolving them in the interpreter is what lets one hazard
  model serve every ISA: SPARC's window rotation and ARM's predication are
  decided before timing sees anything, and x86 flags and POWER CR fields are
  simply more ids. RV64 uses 0–31 for `x`, 32–63 for `f`, and 64 for `fcsr`.
  `x0` appears in neither list, because it can never carry a dependency.
- **Byte addresses throughout.** `inst.target` being an instruction index was
  an artifact of the pseudo-backend. The image maps address to instruction.
- **`at` throws and `speculativeAt` does not.** A mispredicted fetch can
  legitimately run into bytes that are not instructions; executing them cannot.
- **Mid-run state is part of the contract.** `programCounter` and `gpr` are
  not an inspection convenience: differential verification compares state
  before *every* instruction, which is what turns "the answer is wrong" into
  "the answer first went wrong here", and a backend that cannot be read
  mid-run cannot be verified that way.

The consumer is [src/engine/simulateTrace.ts](../../src/engine/simulateTrace.ts),
a trace-driven in-order model that reuses `SetCache`, `DramScheduler`,
`BranchPredictor`, `energyOf`, `isaTiming` and `HardwareProfile` — the same
ones `simulate()` uses, so comparing a pseudo-backend run with a real-ISA run
compares the programs and not two different cache models. It is single-core and
single-threaded. `simulate()` is untouched and still serves the existing
workloads.

---

## 3. What happened to the 47-opcode vocabulary

- **`InstClass` (nine entries) survives** as the timing vocabulary. Functional
  unit selection, `rsEntries`, the energy coefficients and the mix histogram
  all key off it, and real mnemonics map onto it cleanly.
- **`Opcode` (47 entries) does not appear anywhere in the real path.** It
  remains only for the Guest C and IR pseudo-backends, which still work and are
  not being removed until the replacement is proven across the corpus.
- The four places `simulate()` switched on `Opcode` to obtain *timing* facts —
  `latencyOf`, `accessWidth`, `isControl`, `mustDrain` — became the
  `latencyClass`, `accessWidth`, `control` and `serializing` fields above.
  Those switches were the fused design; replacing them is the actual change.

---

## 4. Correctness: what is verified, and against what

Four tiers, all running in `npm test` on any machine, with no Docker.

| Tier | What it checks | Oracle |
| --- | --- | --- |
| Decode | every instruction in the corpus decodes, at the right length, to the right canonical operation | `llvm-objdump` on the same bytes |
| Lockstep | PC and all 32 integer registers **before every instruction** | `qemu-riscv64 -one-insn-per-tb -d cpu` |
| Final state | 32 integer registers, 32 FP registers as raw bits, `fcsr`, and a 1 KiB memory window | the guest's own dump, byte for byte |
| Randomised | the same two comparisons over generated programs | the same, per recorded seed |
| Whole program | what a libc-linked program prints, and its exit status | the same binary under qemu |
| The app's corpus | the same, for the fourteen C programs the app ships | qemu **and** the answers the app already records |

Per target: 40 fixtures for RV64 and 40 for AArch64 — hand-written,
randomised, written against musl, and the app's fourteen. Together, roughly
60,000 instructions compared register by register and thirty-six whole
programs compared on output.

The AArch64 tiers are the same suite, inherited rather than rewritten:
`describeIsaConformance` takes a backend and a fixture directory, so a target
cannot accidentally be held to a weaker standard than the one before it. Two
differences are architectural rather than a choice. AArch64's condition flags
appear in qemu's trace, so NZCV is compared **before every instruction** and
not only at the end — the strongest per-step check either target gets, since
RISC-V's `fcsr` is invisible until the guest reads it. And the final-state
dump covers all 32 vector registers at their full 128 bits, because the guest
writes them out itself.

**The last tier has the most independent oracle of the four.** Every other
comparison is against qemu, which is a different implementation of the same
architecture and could in principle be wrong in the same way. Those
expectations were produced by something else entirely — the in-house Guest C
compiler and the existing pseudo-backend — and are what the shipping app
already validates against. All fourteen agree with both.

One of them needed a compiler flag to get there, which is a finding rather
than a convenience. `fire` seeds an LCG with `int seed = seed * 1664525 +
1013904223`; that overflows, and signed overflow is undefined in C. Guest C
wraps, so the recorded answer assumes wrapping, while clang at `-O2` may
assume the overflow cannot happen. Without `-fwrapv`, `fire` matches qemu
exactly and disagrees with the app — the program is at fault, not either
engine. The flag is applied rather than the program edited, because the
comparison is meant to be about the instruction set rather than about a
compiler's licence to exploit undefined behaviour, and because editing the
program would destroy an expected answer that is currently a real check.

The last tier is compared on output rather than on architectural state, and
that is a limit rather than a preference. A libc owns the entry point and
reads argc, argv, the environment and the auxiliary vector off the initial
stack -- which under qemu is the container's real one and under the
interpreter is synthetic. The two processes genuinely start from different
state and their registers diverge from the first instruction, legitimately.
What must still agree exactly is what the program prints and the status it
exits with, which is the property anything downstream depends on.

### Why the oracle output is committed

Fixtures are generated against the real oracle by
[tools/isa/build-fixtures.ts](../../tools/isa/build-fixtures.ts) and
then checked in. Differential coverage therefore runs in CI and on machines
with no Docker. *Regenerating* needs the oracle; trusting the result does not.
`src/isa/riscv/fixtures/index.json` records the toolchain image, the oracle
image, the target, the flags and every seed.

### Why the guest dumps its own state

`qemu-user`'s `-d cpu` does not emit floating-point registers for RISC-V
(checked, not assumed). So each program ends by writing its whole architectural
state to file descriptor 1, and the interpreter's output is compared with the
reference's byte for byte. This mechanism carries over unchanged to the oracles
with no register-inspection facility at all: the native x86-64 binary, Wasmtime
and `mos-sim`.

### Randomised testing

[tools/isa/rv64/random.ts](../../tools/isa/rv64/random.ts) turns a seed into a
program. Every operation is emitted as inline assembly, because generating C
expressions would mean generating undefined behaviour — a shift wider than the
type, `INT_MIN / -1`, signed overflow — and a program whose meaning C does not
define cannot be a differential test of anything. Operands mix boundary values
with uniform random bits; uniform random alone almost never produces zero, one,
`INT64_MIN`, or two values differing only in sign.

**The randomised seeds found two real bugs that the hand-written cases missed:**

1. `fmv.x.w` and `fsw` applied the NaN-boxing check. They are raw bit
   transfers; the check belongs only to instructions that *operate on* a
   single-precision value.
2. `roundExact` enforced precision and the subnormal floor but not the
   format's maximum exponent. A single-precision fused multiply-add that
   should overflow to infinity returned a finite double instead — the stored
   result was still right, so only the overflow flag was wrong, which is
   exactly the kind of divergence that survives casual testing.

### Loud failure

There is no default arm in any decoder or execute switch.
`UnimplementedInstruction` carries the ISA, address, raw bytes and a
description; `IllegalInstruction` covers bit patterns that are not instructions;
`GuestFault`, `UnsupportedSyscall` and `ExecutionBudgetExceeded` cover the rest.
[src/isa/riscv/faults.test.ts](../../src/isa/riscv/faults.test.ts) asserts each
one, including that `unimp` in the real fixtures is refused rather than skipped.

### Linux process emulation

A libc needs more than instructions. [linux.ts](../../src/isa/common/linux.ts)
supplies the initial stack a program is started with -- argc, argv, envp and
the auxiliary vector -- and the syscalls musl makes: `write`, `writev`, `brk`,
`mmap` including `MAP_FIXED`, `exit`, and the dozen startup calls that have no
interesting behaviour. It is shared rather than per-ISA because riscv64 and
aarch64 use the same asm-generic numbers and the semantics are identical
everywhere; only which registers carry the arguments differs.

Two deliberate departures from a real kernel, both toward reproducibility:
`clock_gettime` returns a fixed instant and `getrandom` a fixed sequence. A
simulator whose output depended on the wall clock or on entropy could not be
differentially tested, because two runs would disagree.

A syscall this layer does not implement throws. Returning `-ENOSYS` would let
a libc take a fallback path and produce a plausible wrong answer. Calls that
are *supposed* to fail -- `ioctl` on something that is not a terminal --
return the real errno, because that is correct behaviour and not a stub.

### What is deliberately not implemented

- **`fence.i`.** Self-modifying code is out of scope.
- **Rounding modes other than nearest-even, for arithmetic.** The host provides
  only one, so an instruction that asks for another is refused rather than
  silently rounded wrongly. Conversions implement all five modes exactly,
  because there the rounding is integral and can be done by hand.
- **Control registers outside `fflags`, `frm` and `fcsr`.**
- **Position-independent executables.** The loader applies no dynamic
  relocations and says so, naming the flags to relink with.

The five IEEE exception flags *are* implemented exactly, including
tininess-after-rounding for underflow. An earlier version modelled only NV and
DZ and masked the rest; the masked comparison was the only divergence left
across the whole corpus, so it was closed rather than documented. Because the
flags are sticky, the exact recomputation is skipped once all three
rounding-dependent flags are set, which keeps a floating-point loop from paying
for them every iteration.

---

## 5. What the remaining six must implement

Adding an instruction set is now a bounded act: implement
[`IsaBackend`](../../src/isa/backend.ts), register it in
[registry.ts](../../src/isa/registry.ts), add a
[`FixtureTarget`](../../tools/isa/fixture-builder.ts) so fixtures can be
captured, and call `describeIsaConformance` from a test file. The backend then
inherits the entire differential suite — lockstep and final-state comparison —
rather than growing its own version that checks slightly less.

```
per ISA     decode, semantics, register file and numbering, ELF machine and
            byte order; a guest harness; a qemu register-dump parser
shared      address space, ELF loading, IEEE-754, the trace interface, the
            timing model, the fixture format and the conformance suite
```

Everything in `src/isa/common/` is reusable as is — `GuestMemory` already
takes endianness as a constructor argument for exactly this reason.

| Target | The structural surprise | Notes |
| --- | --- | --- |
| x86-64 | variable-length decode, flags on nearly everything | Scope to what clang emits at `-O2` — **measured: 76 distinct mnemonics** for the existing corpus — and make the unimplemented set loud. |
| MIPS32 | branch delay slots | The instruction after a branch retires *before* the branch takes effect. `nextPc` in the trace already carries this; the timing model needs no change. |
| POWER | condition-register fields | **Measured: 120 distinct mnemonics**, the widest of the six. Eight CR fields become eight resource ids. |
| SPARC V8 | register windows | Resolve window-relative to absolute register numbers in the interpreter, so `reads`/`writes` reaching timing are already absolute. See the toolchain warning below. |
| WASM | a stack machine, not a register machine | No register file to compare. The differential interface needs rethinking, not just reimplementing. |
| MOS 6502 | 64 KiB, 8-bit accumulator, no OS | Cannot support a C library. Define honestly what it can claim. |

Instruction counts above are measured on the existing C corpus at `-O2`, not
estimated. RV64 needed 49 for that corpus, and 90 across four statically
linked musl binaries, which is the whole of musl and not only the parts a
program reaches; the interpreter that covers it is about a thousand lines of
semantics. "Real ISAs have hundreds of instructions" is true of the
architectures and not of what a compiler emits for this corpus.

### AArch64, as built

The prediction in the table above was that the condition flags would be the
structural surprise. They were the *expected* difficulty and were dealt with
as predicted: NZCV is one more architectural resource id, read by the
conditional selects and the conditional compares and written by the
flag-setting forms, so the existing hazard model handles it with no change.

Three things were harder than the flags, and all three are decode rather than
semantics:

- **Bitfield masks.** `ubfm` and its aliases are defined by `DecodeBitMasks`,
  which produces two masks from `immN:immr:imms`. An implementation that masks
  by the register width instead is right for the common aliases and wrong for
  the general form.
- **Which register 31 is.** It is the zero register in the shifted-register
  forms and the stack pointer in the immediate and extended ones, and which
  it is depends on the operand position as well as the instruction.
- **Advanced SIMD.** Not optional on this architecture: the ABI assumes it, so
  clang emits vector instructions for scalar-looking C and musl's string and
  memory routines are written in them. Sixteen forms were needed to run the
  corpus at all, listed by statically decoding every word of `.text` in all
  eighteen binaries and collecting what the decoder refused — which bounds
  the work up front rather than discovering it one stopped program at a time.
  A libc's `memset` also reaches past the instruction set entirely and asks
  the hardware to zero a cache line, which means `DCZID_EL0` and `dc zva`.

The block size `DCZID_EL0` reports is implementation-defined, and the
temptation is to pick a convenient one. That would be wrong in a way that
would not show up as a wrong answer: a `memset` clears the block size it was
told about, so a different size is a different number of iterations and the
two sides of the differential test stop comparing the same execution. The
fixture reads the register and records what it said; the reference says 512
bytes, so that is what the interpreter reports and what `dc zva` clears.

Because the corpus tier is compared on output rather than on state, a vector
instruction it happens not to depend on could be wrong and still pass. So the
SIMD subset has an architectural fixture of its own,
[asm_simd.c](../../tools/isa/aarch64/programs/asm_simd.c), whose inputs hold a
different value in every lane at every element size — which is what makes a
wrong lane index, a wrong element size or the wrong half of a widening
operation show up rather than merely be possible. It found a real one
immediately: `xtn` was truncating each lane to the *source* element width
instead of the narrowed one, so the packed lanes overlapped. Every corpus
program still printed the right answer with that bug in place.

### What an AArch64 target descriptor needs, measured

The one part of the oracle layer that genuinely cannot be shared is parsing
qemu's register dump, and the difference is larger than it looks. Captured
from `qemu-aarch64 -one-insn-per-tb -d in_asm,cpu,nochain`:

```
 PC=0000000000210120 X00=0000000000000000 X01=0000000000000000
X02=0000000000000000 ...
X29=0000000000000000 X30=0000000000000000  SP=000077c16b1f1d80
PSTATE=0000000040000000 -Z-- EL0t  SVCR=00000000 --  BTYPE=0
```

Three things follow. The register spelling is `X%02d=` with sixteen hex
digits, not RISC-V's `x%d/%s` with variable width. The stack pointer is
separate from the numbered registers rather than being one of them, so a
lockstep comparison has to decide where to put it. And **PSTATE is in the
trace**, which means AArch64's condition flags can be verified per instruction
— a significant advantage over RISC-V, where `fcsr` is only visible when the
guest reads it.

Also worth knowing: this qemu build has no AArch64 disassembler, so `in_asm`
prints `OBJD-T: 04000094` — the raw encoding — instead of a mnemonic. That is
still useful as a decoder oracle, and `llvm-objdump` supplies the text.

### The libc, decided and built

There was no cross libc in any of the toolchain images.
[Dockerfile.sysroot](../../tools/isa/Dockerfile.sysroot) now builds one:
**musl 1.2.5**, from a checksummed tarball, for riscv64, aarch64 and x86_64.
It builds in seconds and adds about 10 MB per target.

musl alone turned out not to be enough, which is not visible until the first
link fails. Its `printf` supports `long double`, and `long double` on RISC-V
and AArch64 is binary128, which no hardware here implements -- so the link
reaches for `__extenddftf2` and its relatives from compiler-rt whether or not
the program mentions a long double. The builtins are therefore built
alongside, from the same pinned LLVM release the compiler came from, by
[build-builtins.sh](../../tools/isa/build-builtins.sh). Driving CMake to
cross-compile them needs more scaffolding than compiling them directly does.

Adding a target is one entry in each loop, plus its triple.

**SPARC is the exception and will need separate work.** musl has no SPARC port
at all, and `lld` cannot link SPARC either (`unknown emulation: elf32_sparc`,
verified) — which is what `isa-sim/sparc-linker:2.40-2` exists for. That
target needs binutils, and picolibc or a freestanding subset.

### What a libc program actually needs, measured

Running one was the only way to find out, and the answer was three things
beyond the instruction set, each discovered by the run stopping:

1. **Process startup.** musl reads the auxiliary vector before `main`. On a
   zeroed stack it gets `AT_PAGESZ` of zero and computes nonsense in its
   allocator, failing later somewhere unrelated.
2. **A syscall surface.** Roughly twenty calls, of which only `write`,
   `writev`, `brk` and `mmap` do anything.
3. **The A extension.** musl's allocator uses atomics from its first call. On
   one hart these are ordinary read-modify-write operations, so implementing
   them was cheaper than refusing them, and they are verified against qemu
   like everything else.

### A gap worth naming

The existing C corpus emits **zero floating-point instructions** — Mandelbrot
and the rest are fixed-point, and the FP workloads are IR-only. The FP
requirements are met here by programs written for the purpose
(`fp_bin`, `fp_cvt`, the randomised seeds), not by the corpus. Any target that
claims FP support needs the same.

---

## 6. How it reaches the app

The real backends appear in a lane of their own, beside the two modelling
lanes, with an instruction-set selector at the top of it. They are
deliberately not extra columns in the eight-way comparison.

Putting a real instruction stream next to a pseudo-backend in a single table
would invite reading both as equally real, and the project's honesty
guarantees are the thing that would pay for that. The lane therefore runs one
target at a time, says at the top which one and what about it is executed
versus modelled, and states that it is not comparable to the other lanes.
Existing numbers, saved runs and exported reports are untouched.

The claims the lane makes about a target are data rather than prose:
[realTargets.ts](../../src/lanes/realTargets.ts) carries the oracle's name and
how far the comparison against it goes, so a target cannot be added to the
menu without saying what verified it.

Three consequences worth knowing:

- **The programs are fixed.** The app cannot compile at runtime — the minimal
  clang image is 912 MB and needs Docker — so the lane runs binaries built
  ahead of time. Editing the C and re-running stays a pseudo-backend feature.
- **The shipped bytes are the verified bytes.** The lane loads the same
  `corpus-*.elf` files the differential suite compares against qemu, not a
  rebuild of them. A test asserts that.
- **They are inlined, and the lane is code-split.** The packaged app loads
  over `file://`, where fetching a sibling file is blocked, so the binaries
  become `data:` URIs in the bundle. Two targets' worth is 1.09 MB, which
  would be dead weight for anyone who never opens the lane, so the lane is a
  lazy chunk and the main bundle is unchanged at 657 KB.

## 7. Running it

```
npm test                                         # includes the full differential suite
npx vite-node tools/isa/build-fixtures.ts rv64     # regenerate fixtures; needs Docker
npx vite-node tools/isa/build-fixtures.ts aarch64
```

Regeneration requires `isa-bench/codegen-min:23.1.0`,
`isa-sim/qemu-user:11.1.0`, and for the libc tier
`isa-bench/codegen-musl:23.1.0-1.2.5`, which is built by

```
docker build -f tools/isa/Dockerfile.sysroot \
  -t isa-bench/codegen-musl:23.1.0-1.2.5 tools/isa
``` The initial stack pointer recorded in each lockstep
fixture comes from qemu and varies between captures, because qemu-user
randomises it; the programs set their own stack immediately, so it does not
affect execution, but it is why regenerating produces a diff even when nothing
else changed.
