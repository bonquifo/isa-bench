# Real instruction-set semantics

Written for engineers continuing this work on the remaining three targets.

This describes the interpreters that replace the pseudo-backend lowering, the
interface they present to the timing model, and what the remaining instruction
sets have to implement.

**Five are complete: RV64GC, AArch64, x86-64, MIPS32 and MOS 6502.** For
the first four, real C compiled by clang and linked against a real libc
executes against a real address space and matches its reference on
architectural state for freestanding programs and on output for whole
programs. The fifth makes a different claim, stated in section 4 and
section 5, because it is the one target with no reference it can be
stepped alongside.

The second one is the evidence that the split in section 1 was worth making:
AArch64 needed a decoder, a semantics file and a register map, and reused the
address space, the ELF loader, the IEEE-754 layer, the Linux process
emulation, the timing model, the fixture builder and the conformance suite
without changing any of them.

The third needed two changes, and both are worth knowing about. Its reference
is not qemu but the host processor, single-stepped through ptrace, so an
oracle became a pair of commands rather than a path to an emulator. And it is
the first architecture whose specification leaves some of its own state
*undefined* after particular instructions, which the comparison had to be
taught about; section 4 says what that means and what stops it being a way to
hide a difference.

The fourth is the first 32-bit one, and the first whose control flow is not
sequential in the obvious sense: a MIPS branch takes effect one instruction
late, and the instruction in between runs either way. That is handled where it
belongs, in the interpreter, and section 5 explains why nothing downstream of
the retired trace needs to know about it.

The fifth is the one that had to change how a backend is verified rather
than what it implements. There is no traceable 6502 emulator to run in
lockstep, so the middle tier is replaced by per-opcode cases recorded
from hardware -- which for a single instruction says more than lockstep
does, and for a sequence of them says nothing. It is also the first
target whose whole-program oracle was found to be *wrong*, in a way the
hardware vectors could prove; section 5 says what was done about that.

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

Five tiers, all running in `npm test` on any machine, with no Docker. Four
of them apply to every target; the fifth exists because one target could
not have the others.

| Tier | What it checks | Oracle |
| --- | --- | --- |
| Decode | every instruction in the corpus decodes, at the right length, to the right canonical operation | `llvm-objdump` on the same bytes |

The decode tier is shared, which it was not at first. RV64 had it alone
while three other targets captured the same disassembly and used none of
it. Promoting it into `describeIsaConformance` cost a morning and found a
real bug in the first backend it was pointed at: AArch64 decoded `clrex`
as a memory barrier, because the guard keyed on the wrong field of the
system-instruction encoding. Nothing else had noticed, because nothing in
the corpus executes it.

That is the argument for the tier in one sentence: it asks whether the
decoder and LLVM agree about which instruction a sequence of bytes *is*,
which is a weaker question than the lockstep tier answers and can be
asked before a line of semantics exists. For a target still being built,
that is the difference between finding a wrong encoding table
immediately and finding it through a wrong answer weeks later.

Each backend supplies three things: how to decode bytes at an address,
what it calls an operation, and which of the disassembler's
pseudo-instruction names may stand for which real one. The third is most
of the work and is self-checking -- an alias listed wrongly fails the
test rather than hiding anything.
| Lockstep | PC and all 32 integer registers **before every instruction** | `qemu-riscv64 -one-insn-per-tb -d cpu` |
| Final state | 32 integer registers, 32 FP registers as raw bits, `fcsr`, and a 1 KiB memory window | the guest's own dump, byte for byte |
| Randomised | the same two comparisons over generated programs | the same, per recorded seed |
| Whole program | what a libc-linked program prints, and its exit status | the same binary under qemu |
| The app's corpus | the same, for the fourteen C programs the app ships | qemu **and** the answers the app already records |
| Per-opcode | the whole machine before and after **one** instruction, from arbitrary state | cases recorded from 6502 hardware |

Per target: 40 fixtures for RV64, 40 for AArch64, 37 for x86-64 and 35 for
MIPS32 — hand-written, randomised, written against musl, and the app's
fourteen. Together, roughly 130,000 instructions compared register by
register and seventy-two whole programs compared on output. The 6502 adds
23,502 single-instruction cases and 16 whole programs, and no lockstep;
section 5 says why, and what that does and does not let it claim.

### The x86-64 reference is not an emulator

Every other target is compared against qemu, which is a second
implementation of the same specification and could in principle be wrong in
the same way an interpreter is. On x86-64 that doubt can be removed, because
the machine running the tests is the machine the code is for. The reference
is therefore the processor itself, single-stepped through `PTRACE_SINGLESTEP`
with its registers read before every instruction — the same comparison qemu's
`-d cpu` gives elsewhere, against hardware rather than a model of it. The
tracer is a hundred lines, in
[tools/isa/native/trace.c](../../tools/isa/native/trace.c).

Using the real thing costs three things, all of them small and all of them
named where they happen. Address-space randomisation has to be turned off, or
two captures of the same program differ for no architectural reason; the
system call that does it is rejected by Docker's default seccomp profile, so
the container runs without it, which is a real relaxation confined to fixture
generation. `syscall` copies the whole flag word into r11, and while the
child is being single-stepped that word contains the trap flag the tracer
itself set — so the tracer clears exactly that bit, in the child, after
exactly that instruction. And one syscall's result is the process id, which
is environmental; it appears in the libc tier, which is compared on output
rather than on state, so it changes nothing.

### Undefined is not the same as unchanged

x86 defines several instructions to leave particular flags *undefined*: a
divide leaves all six, a shift by more than one leaves the overflow flag,
every logical operation leaves the adjust flag. A processor still puts
something there. Insisting on those bits would be insisting that an
interpreter reproduce behaviour no specification promises and no program may
rely on.

So the interpreter publishes what it does not claim, through `undefinedBits`
on the trace interface, and the conformance suite excludes exactly those bits
and nothing else. Three things keep that from becoming a way to hide a
difference:

- **It is sticky, and has to be.** An instruction that leaves a flag
  undefined puts an unknown value there; the next instruction that merely
  *preserves* that flag passes the unknown value on. Clearing the set every
  instruction would claim the value back a step later without anything having
  produced it — and the fixtures caught exactly that, as a rotate
  disagreeing about a flag it had not written.
- **It is bounded and counted.** The suite asserts that what a backend
  declines to claim is at most six bits of at most one register. The other
  two targets claim every bit of every register, and `undefinedBits` is
  optional so they say nothing at all.
- **The programs never read an undefined flag into a register.** They used
  to: the first version of the generated tests read the flag word with
  `seto` and `lahf` after every operation, which copies undefined bits into
  an ordinary value where nothing can exclude them. The flags are compared
  before every instruction anyway, which is stricter than a snapshot, so the
  capture was removed rather than corrected. The same reasoning put a
  `cmp` in front of every `syscall` in the x86 harness.

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

## 5. What the remaining three must implement

Adding an instruction set is now a bounded act: implement
[`IsaBackend`](../../src/isa/backend.ts), register it in
[registry.ts](../../src/isa/registry.ts), add a
[`FixtureTarget`](../../tools/isa/fixture-builder.ts) so fixtures can be
captured, and call `describeIsaConformance` from a test file. The backend then
inherits the entire differential suite — lockstep and final-state comparison —
rather than growing its own version that checks slightly less.

A target with no traceable reference takes a different route, which the
6502 opened: call `describeDecodeTier` directly for the tier that only
needs a disassembly, and bring its own oracle for the rest. WASM will
almost certainly take that route too.

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
| POWER | condition-register fields | **Measured: 120 distinct mnemonics**, the widest of the five. Eight CR fields become eight resource ids. |
| SPARC V8 | register windows | Resolve window-relative to absolute register numbers in the interpreter, so `reads`/`writes` reaching timing are already absolute. See the toolchain warning below. |
| WASM | a stack machine, not a register machine | No register file to compare. The differential interface needs rethinking, not just reimplementing. |

Instruction counts above are measured on the existing C corpus at `-O2`, not
estimated. RV64 needed 49 for that corpus, and 90 across four statically
linked musl binaries, which is the whole of musl and not only the parts a
program reaches; the interpreter that covers it is about a thousand lines of
semantics. "Real ISAs have hundreds of instructions" is true of the
architectures and not of what a compiler emits for this corpus.

x86-64 is the one that came closest to contradicting that, and is worth
quoting as the ceiling: 193 opcode-map entries statically, 168 distinct
mnemonics actually executed. Even there the number of distinct *operations*
is far smaller, because twenty of those mnemonics are one conditional move
and sixteen are one conditional branch.

### MOS 6502, as built

The prediction in the table was "cannot support a C library; define
honestly what it can claim". Half of that was wrong and the other half
turned out to be the entire job.

**It supports a C library.** llvm-mos ships a `sim` target with a real
`printf`, and thirteen of the app's fourteen corpus programs compile,
link and run on it. The one that does not is refused for a reason that
belongs to the architecture rather than to the backend: `int` is sixteen
bits here, so the program's own `sizeof(struct Point) == 8` assertion is
false, and the compiler is right to stop. That is recorded in
`fixtures/corpus.json` with its reason and asserted in a test, so it is a
stated fact rather than a program that quietly vanishes from the menu.

**Defining what it can claim was the whole job**, because this is the
only target with no reference it can be stepped alongside.

#### There is no lockstep, and what replaces it is better in one direction

`mos-sim` has no tracing interface — no flag, no hook, 72 KB of binary
with nothing to ask. So the tier every other backend leans on, PC and
registers compared before every instruction, cannot exist here.

What exists instead is the SingleStepTests vectors: for each of the 256
opcodes, ten thousand cases recorded from hardware, each giving the
entire machine before, one instruction, and the entire machine after.
For a single instruction that is a *stronger* statement than lockstep. A
lockstep run only ever reaches the states a compiler's output happens to
produce, and a compiler emits `sed` never, `adc` with overflow already
set rarely, and `jmp` through a pointer at `$xxFF` not at all. These
cases set the whole status register at random, so they reach
combinations no corpus program would.

For a *sequence* of instructions it says nothing at all, which is why
the whole-program tier carries more weight here than elsewhere. The
claim this target makes is stated in those two halves, not as "verified
against a reference", which would be borrowing the other targets'
sentence.

#### The sample, and why it is not uniform

All 256 files are 840 MB, so a deterministic sample is committed —
23,502 cases, 1008 KiB — and
[`build-vectors.ts`](../../tools/isa/mos/build-vectors.ts) regenerates
it. Downloading at test time was rejected outright: a suite whose result
depends on the network is not a conformance suite.

The sample is uniform *plus* a targeted pass, and the targeted pass
earns its place. The cases that catch bugs are structural edges — a zero
page pointer wrapping at `$FF`, an indexed address crossing a page, a
stack pointer at either end, an indirect jump through the address the
hardware gets wrong — and each is rare enough that 128 uniform draws
usually contain none. When the tier was deliberately broken to check it
could fail, removing the indirect jump's page-carry defect failed
**exactly 8 of 159 cases for opcode `6c`**: the eight the targeted pass
had put there. A uniform-only sample would have passed.

#### The whole-program oracle is wrong, and the vectors proved it

This is the part worth carrying to the next target. `mos-sim` does not
implement decimal mode the way the hardware does:

- **N and V** are taken from the plain binary sum. On an NMOS 6502 they
  come from the partly corrected value — the sum after the low nibble is
  adjusted and before the high one is — which is a value that is never
  stored anywhere.
- **Operands with a nibble above nine** produce the wrong accumulator,
  because the correction is applied as though the input were valid BCD.

That was not inferred from reading. Sixty-four decimal cases were taken
from the hardware vectors, assembled into a program and run under the
simulator: **eight wrong accumulators and one wrong flag pair**, with
this interpreter matching hardware on all sixty-four.

The response was not to make the interpreter agree with the simulator.
It was to bound what the whole-program tier compares — the decimal probe
stays inside valid BCD and reports the accumulator and carry, which is
the part the simulator gets right — and to add a test pinning the
divergence so nobody later "fixes" the backend to match the oracle. That
test is in
[`conformance.test.ts`](../../src/isa/mos/conformance.test.ts) and its
comment says exactly which mistake it guards against.

The general lesson: an oracle is evidence, not authority. Where two
oracles disagree, the one recorded from hardware wins, and the
disagreement gets a test rather than a workaround.

#### The 105 encodings that are not instructions

The opcode map has 151 entries and 256 slots. The other 105 do something
on real silicon — they are the "undocumented" instructions, undocumented
because they fall out of the decode logic rather than because anyone
designed them — and this decoder refuses every one. That is a deliberate
narrowing, it is asserted for all 105, and it costs nothing measurable:
across 41,443 instructions of disassembly over the fixture set, LLVM
printed only documented mnemonics, so nothing a compiler emits is
affected.

#### What was different in the substrate

Three things, each small and each for a reason:

- **The address space is not `GuestMemory`.** This machine has no MMU.
  Every address responds, there is no such thing as a segmentation
  fault, and the conformance vectors poke arbitrary addresses and expect
  an answer. A page table with faults would model behaviour the hardware
  does not have. `MosBus` is 64 KiB and a device list.
- **Each status flag is its own resource id**, where other targets treat
  the condition register as one. With three registers and no barrel
  shifter, *everything* here is done through flags: a 16-bit add is four
  instructions chained through carry, and a loop is a decrement whose
  zero flag is read six instructions later while carry is being used for
  something else. Collapsing them would make the timing model report
  dependence stalls that do not exist.
- **The decode cache can be invalidated.** Self-modifying code is not a
  curiosity on a machine with three registers; rewriting an
  instruction's operand is an ordinary way to index. A store checks
  whether it landed inside the decoded range — which stores to page zero
  and the stack never do — and drops the three addresses that could have
  been affected.

#### The platform is ten addresses

There are no syscalls on a 6502. Where other targets have several
hundred lines of Linux emulation, this one has a device occupying
`$FFF0`–`$FFF9`. Every address in it was read off the simulator by
compiling code that uses the facility, disassembling what the platform's
libc emits, and confirming with a probe program; none of it came from
documentation.

`$FFF8` exits with a status and `$FFF9` writes a byte to stdout. `$FFF5`
and `$FFF6` are input and its end-of-file flag. **`$FFF0`–`$FFF3` are a
cycle counter, and this backend refuses to answer them.** That is the
one deliberate refusal of a facility the reference provides, and the
reason is section 1's split: execution here produces architectural
state, and cycles are the timing model's answer against a hardware
profile. There is no count inside the interpreter to return. The two
ways to invent one are both worse than failing — a retired-instruction
count would be a fabricated number wearing real units, and feeding the
timing model's answer back to the guest would let a simulated program's
*output* depend on the profile it was simulated under.

#### `int` is sixteen bits, and the corpus noticed

The strongest tier on every other target is the app's own recorded
answers: expectations produced by the in-house Guest C compiler and the
pseudo-backend, which share nothing with clang or an interpreter. Here
it splits in two, and the split is exact.

`int` is sixteen bits on this machine, and the corpus was written where
it is thirty-two. Eight of the thirteen buildable programs accumulate
past 32767 — `pi` returns pi scaled by 100000, `fft` a checksum in the
hundreds of millions — and those eight compute a different value here.
They are right to: same C, same compiler, narrower type.

What makes this a finding rather than an excuse is that the line falls
in exactly one place. **Every program whose expected answer fits in a
sixteen-bit `int` matches the app completely, return value and output;
every program whose answer does not fit differs, and its own answer
always fits.** Nothing is in between. The test derives that split from
the expected value rather than from a list of program names, so a
program that started disagreeing for some *other* reason would fail.

Two of the eight, `life` and `cube`, return a different value and still
print byte-identical output, because what they print does not depend on
the accumulator that overflows.

The lane says this in the UI rather than reporting a mismatch, since a
red "does not match" on eight of thirteen programs would be describing
the C type system as a bug in the interpreter.

#### The initial state was measured, not assumed

A real 6502 sets the interrupt-disable flag during reset. This platform
has no reset sequence: the simulator loads the image and enters the
program with a cleared status register. A probe measured `S = $FD` and
all flags clear, and the interpreter matches that — which mattered,
because a guest that pushes its status word at startup can see the
difference, and the first version of the decimal probe did.

### MIPS32, as built

The prediction was the delay slot, and for once the prediction was the
whole story — but not in the way the table suggested. It said `nextPc`
already carries it and the timing model needs no change, and both turned
out to be true: the interpreter retires the branch and the instruction
after it as two entries in execution order, each with its own successor,
and nothing downstream has any notion of a delay slot at all.

What the table did not say is that this is the one architectural feature
in the project that an implementation can get *wrong* while still
producing the right answer. A program whose delay slots are all `nop` —
which is most compiled code at `-O0` — behaves identically whether the
slot runs before or after the branch. So the lockstep tier is doing more
work here than anywhere else, and the randomised generator puts something
observable in every slot it emits rather than leaving the choice to the
assembler.

Three things beyond the delay slot were not obvious:

- **`-mno-abicalls` does the opposite of what it sounds like.** A
  freestanding binary cannot use the position-independent convention,
  because that expects the caller to have left the callee's address in
  `t9` for it to compute the global pointer from, and a hand-written
  entry stub has not. `-fno-pic` fixes it. Adding `-mno-abicalls`
  *enables* gp-relative addressing of small data, so the code then needs
  the global pointer it was previously only computing — the same crash,
  arrived at from the other side.
- **The o32 ABI passes a syscall's fifth and sixth arguments on the
  stack**, in slots the caller reserves. Reading them unconditionally
  faults for every four-argument call made with the stack pointer at the
  top of its mapping, which is exactly where a freestanding program's
  is. Only `mmap` has them.
- **A 32-bit target makes pointer width visible in the syscall layer.**
  Arguments arrive in registers whatever their width, so almost nothing
  changed — but an `iovec` is two pointers read out of memory, and
  reading it at eight bytes apiece gives an address assembled from half
  of one field and half of the next. That, and the initial stack, are
  the only two places the shared code needed to learn the difference.

The floating-point unit was the piece the measurement got wrong.
Statically the eighteen binaries contain 89 distinct mnemonics, of which
a quarter are coprocessor 1: `long double` is the same as `double` here,
so musl's printf uses the hardware unit rather than a software format.
Including a multiply-add, which needs a fourth register field and
therefore an escape opcode of its own, and which rounds once rather than
twice.

### x86-64, as built

The prediction was variable-length decode and flags on nearly everything.
Both were true and neither was the hard part.

Scope was settled by measurement before a line was written, twice over.
Statically, the eighteen binaries contain **193 distinct opcode-map
entries**. Dynamically — single-stepping each one and mapping every executed
address back to its disassembly — they execute **168 distinct mnemonics**,
of which 147 are ordinary integer and SSE instructions and 21 are x87.

That second measurement decided the shape of the work, because it showed
**all fourteen corpus programs execute zero x87 instructions**. The x87 stack
is reached only by three libc programs, and only because they print a
floating-point number. So the integer and SSE interpreter could be finished
and verified on its own, with x87 added afterwards as a separable piece,
rather than everything having to work before anything could be tested.

Three things were harder than the flags:

- **SSE is not optional.** The ABI passes a double in an xmm register, so a
  program that never vectorises still uses them, and clang turns an
  unsigned-to-double conversion into a fixed sequence of packed integer
  instructions because the architecture has no single instruction for it.
- **The 0x66 prefix is not an operand-size override on an SSE opcode**, it
  is part of the opcode. Asking the usual question gives sixteen bits, and a
  `movd` that writes sixteen bits of a register leaves the other half of the
  old value in place. That was a real bug, and the one that made
  `corpus-nbody` print a wrong answer.
- **x87 is an 80-bit format whose precision is a control-register field.**
  The leading significand bit is stored rather than implied, so the encoding
  can hold values the format cannot interpret; and the same `fmul` rounds to
  64, 53 or 24 significant bits depending on what was last loaded into the
  control word, which musl changes mid-computation. It is implemented
  exactly, on BigInt significands, in
  [x87.ts](../../src/isa/x86/x87.ts) — the host's doubles would be wrong in
  the last few bits of every operation, which is the part a digit generator
  is looking at.

**The architectural fixtures earned their place three times.** `asm_sse.c`
found the `movd` width bug. `asm_x87.c` found the memory-operand form of
every x87 arithmetic instruction using the top of the stack as *both*
operands, so `fadd` doubled instead of adding — every corpus program still
printed the right answer with that bug in place, because none of them
executes x87. And the randomised seeds found `shld` and `shrd` not computing
the overflow flag for a shift of one, which is the only count it is defined
for.

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
  become `data:` URIs in the bundle. Four targets' worth is 2.18 MB, which
  would be dead weight for anyone who never opens the lane, so the lane is a
  lazy chunk and the main bundle is unchanged at 657 KB.

## 7. Running it

```
npm test                                         # includes the full differential suite
npx vite-node tools/isa/build-fixtures.ts rv64     # regenerate fixtures; needs Docker
npx vite-node tools/isa/build-fixtures.ts aarch64
npx vite-node tools/isa/build-fixtures.ts x86
npx vite-node tools/isa/build-fixtures.ts mips
```

The 6502 is regenerated by two scripts of its own rather than by
`build-fixtures.ts`, because it has neither a lockstep oracle to drive
nor a qemu register dump to parse:

```
npx vite-node tools/isa/mos/build-vectors.ts    # per-opcode cases; needs network
npx vite-node tools/isa/mos/build-corpus.ts     # whole programs; needs Docker
```

The first downloads about 500 MB from the SingleStepTests repository,
pinned to a commit, and writes a 1 MB sample. The second needs
`isa-sim/mos:23.0.1`, which carries llvm-mos and `mos-sim`.

The x86-64 target needs one more image, which is built here rather than
pulled because the thing being trusted is the tracer:

```
docker build -f tools/isa/Dockerfile.native -t isa-bench/native-x86:1 tools/isa
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
