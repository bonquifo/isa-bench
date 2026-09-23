# Real instruction-set semantics

Written for engineers maintaining or extending this work.

This describes the interpreters that replace the pseudo-backend lowering, the
interface they present to the timing model, and how each instruction set was
verified.

**All eight are complete: RV64GC, AArch64, x86-64, MIPS32, MOS 6502,
SPARC V8, POWER and WebAssembly.** For the first four, real C compiled by
clang and linked against a real libc executes against a real address space
and matches its reference on architectural state for freestanding programs
and on output for whole programs. WebAssembly makes the same claim by a
different route: it has no lockstep tier because no engine can be stepped,
but all fourteen corpus programs match wasmtime byte for byte, and every
operation is compared against a second engine on every edge value of its
operand types.

The 6502 makes a narrower claim, and says so: it has no reference it can
be stepped alongside. SPARC makes the same claim as the first four with
one qualification it states wherever its results appear -- musl has no
SPARC port, so its library is picolibc with a platform layer of this
project's, and the instructions inside printf are picolibc's.

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

The seventh is the one where the *order* of the work was the whole
argument. Its decoder was checked against LLVM over nine thousand
instructions before a line of semantics existed, which found four
encoding mistakes at the cheapest possible moment -- and then lockstep
found five more of a kind that tier cannot see, because agreeing about
which instruction a word is says nothing about the values in its
fields.

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
  per-ISA space. Resolving them in the backend is what lets one hazard
  model serve every ISA: ARM's predication is decided before timing sees
  anything, and x86 flags, SPARC condition codes and POWER CR fields are
  simply more ids.

  SPARC is the one place this does not resolve all the way, and the
  reason is a real limit rather than an omission. Which *physical*
  register `%l0` names depends on the current window, which is dynamic,
  and these ids belong to a statically decoded instruction the image
  caches by address. So that target identifies window registers
  window-relative and makes the window pointer a resource of its own,
  which every instruction naming one reads. Section 5 says what stays
  approximate and why the contract was not reopened for it. RV64 uses 0–31 for `x`, 32–63 for `f`, and 64 for `fcsr`.
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
| Decode | every instruction in the corpus decodes, at the right length, to the right canonical operation, and where a field chooses the behaviour, to the exact name that field implies | `llvm-objdump` on the same bytes |
| Lockstep | PC and all 32 integer registers **before every instruction** | `qemu-riscv64 -one-insn-per-tb -d cpu` |
| Final state | 32 integer registers, 32 FP registers as raw bits, `fcsr`, and a 1 KiB memory window | the guest's own dump, byte for byte |
| Randomised | the same two comparisons over generated programs | the same, per recorded seed |
| Whole program | what a libc-linked program prints, and its exit status | the same binary under qemu |
| The app's corpus | the same, for the fourteen C programs the app ships | qemu **and** the answers the app already records |
| Per-opcode | the whole machine before and after **one** instruction, from arbitrary state | cases recorded from 6502 hardware |

Per target: 41 fixtures for RV64, 40 for AArch64, 37 each for x86-64 and
POWER, 35 for MIPS32 and 34 for SPARC -- hand-written, randomised, four
written against a real libc, and the app's fourteen. Together, 283,652
instructions compared register by register and 108 whole programs
compared on output. WebAssembly has no lockstep; it compares every
operation against every edge value, and the whole of linear memory,
against the engine the tests run in, and its fourteen corpus programs'
output against wasmtime. The
6502 adds 23,502 single-instruction cases and 16 whole programs, and no
lockstep either; section 5 says why, and what that does and does not let it claim.

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

Each backend supplies four things: how to decode bytes at an address,
what it calls an operation, which of the disassembler's
pseudo-instruction names may stand for which real one, and a
**signature** -- the exact name the decoded fields imply. The alias
table is for names that differ by operand (`mv` is an `addi` of zero),
which the lockstep tier checks as it executes. The signature is for
names that differ by a field the interpreter acts on -- a width, a
condition, a precision, a rounding mode -- and where it has an answer
the alias table is not consulted at all. Why both are needed is in the
POWER section below; what the audit that added signatures to every
target found is next.

#### The decode audit

Membership let a wrong field through on POWER five times (see *Why the
decode tier let them through*), so every target's check was rebuilt
around signatures and run over every captured disassembly, including the
libc and corpus binaries. Each signature was then broken on purpose --
conditions swapped, precisions swapped, widths swapped, the annul bit
inverted -- to confirm the tier fails, so a signature that quietly
returns nothing cannot pass for one that checks. The tier also fails
outright if a signature exists and was never consulted.

| Target | Instructions | Checked by signature | Mis-decodes in the fixtures |
| --- | --- | --- | --- |
| RV64 | 129,485 | 70,754 | 0 |
| AArch64 | 109,487 | 58,200 | 0 |
| x86-64 | 106,187 | 87,686 | 0 |
| MIPS32 | 115,497 | 13,267 | 0 |
| SPARC V8 | 95,875 | 57,715 | 0 |
| POWER | 130,463 | 64,393 | 0 |

No fixture instruction was mis-decoded. What the audit did find was in
the encodings no fixture reaches, where a wrong table entry waits for
the first program that uses it:

- **AArch64 decoded vector `orr` and `bic` by immediate as `movi`.** They
  share the modified-immediate encoding, but they merge into the
  destination and `movi` replaces it. They are now refused.
- **POWER's VSX table was wrong in five places.** Checked against the
  words LLVM assembles, `xscmpudp` and `xscmpodp` were decoded as
  negated multiply-adds, `xsaddsp` and `xssubsp` as compares, the negated
  multiply-adds sat at encodings that are something else, and `xvsubsp`
  and `xvdivsp` were decoded as add and multiply. The compares and
  multiply-adds now sit at their measured encodings; the rest are
  refused.
- **POWER took every `tw` and `td` as an unconditional trap.** A
  conditional trap that should not fire would have stopped the program.
  Only the unconditional forms are accepted now.
- **x86's tier could not read whole programs.** When a REX byte follows
  `lock`, `llvm-objdump` prints the prefix on a line of its own, and the
  parser took it for a one-byte instruction. The parser now joins the
  two. `hlt`, which musl leaves after its exit call, is refused.
- The x87 register forms that write `st(i)` are named the other way
  round in AT&T syntax -- Intel's `fsubp` is `fsubrp` -- which the
  signature has to reproduce. The arithmetic was already right; lockstep
  against qemu had checked it.

What is still membership is only what the interpreter cannot tell
apart: aligned and unaligned 128-bit moves, `ucomis` and `comis`,
`fcmp` and `fcmpe`, and single- and double-precision bitwise operations.

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

## 5. How each target was added

All eight targets now execute real instructions. Adding one is a bounded
act: implement [`IsaBackend`](../../src/isa/backend.ts), register it in
[registry.ts](../../src/isa/registry.ts), add a
[`FixtureTarget`](../../tools/isa/fixture-builder.ts) so fixtures can be
captured, and call `describeIsaConformance` from a test file. The backend
then inherits the entire differential suite — lockstep and final-state
comparison — rather than growing its own version that checks slightly
less.

A target with no traceable reference takes a different route, which the
6502 opened and WebAssembly then took: call `describeDecodeTier` directly
for the tier that only needs a disassembly, and bring its own oracle for
the rest. Two of the eight went that way, which is enough to say the
split was worth extracting rather than a special case dressed up as one.

```
per ISA     decode, semantics, register file and numbering, ELF machine and
            byte order; a guest harness; a qemu register-dump parser
shared      address space, ELF loading, IEEE-754, the trace interface, the
            timing model, the fixture format and the conformance suite
```

Everything in `src/isa/common/` is reusable as is — `GuestMemory` already
takes endianness as a constructor argument for exactly this reason.

The contract was frozen after RV64GC and before the other seven, which is
the cheapest moment to get it wrong. It survived all seven with one
documented addition and one field that does not apply: WebAssembly's
`elfMachine` is zero, because a module is not an ELF file. That is a
better outcome than freezing it late would have produced, and it is the
only evidence available that freezing early was right rather than lucky.

Instruction counts below are measured on the existing C corpus at `-O2`,
not estimated. RV64 needed 49 for that corpus, and 90 across four
statically linked musl binaries, which is the whole of musl and not only
the parts a program reaches; the interpreter that covers it is about a
thousand lines of semantics. "Real ISAs have hundreds of instructions" is
true of the architectures and not of what a compiler emits for this
corpus.

x86-64 is the one that came closest to contradicting that, and is worth
quoting as the ceiling: 193 opcode-map entries statically, 168 distinct
mnemonics actually executed. Even there the number of distinct
*operations* is far smaller, because twenty of those mnemonics are one
conditional move and sixteen are one conditional branch.

WebAssembly is the other end of the same argument for a different reason:
180 opcodes implemented, but the compiled corpus reaches only 97 of them.
The rest exist because the instruction set is small enough to cover
completely, not because a compiler asked for them.

### WebAssembly, as built

The table above predicted the structural surprise correctly — a stack
machine, not a register machine — and then drew the wrong conclusion
from it. It said the differential interface "needs rethinking, not just
reimplementing". It did not. The frozen `IsaBackend` contract took this
target unchanged, and the reason is a fact about the format rather than
about the design.

#### The stack depth is static, so there is still a resource to name

`i32.add` reads "the top two" and writes "the top one". Which storage
that is depends on how deep the stack is, which sounds dynamic and is
not: **a valid module's stack depth at every instruction is statically
determined**, because the validation rules that make a module valid are
exactly the rules that force it. So the analysis in
[image.ts](../../src/isa/wasm/image.ts) is not an approximation of a
dynamic quantity; it is the quantity, computed once per function.

That gives the flat resource space the contract wants — a slot named by
its depth, a local by its index, a global by its index — and two
`i32.add`s at different depths come out genuinely independent, which is
the thing a timing model needed to know.

The same walk resolves the branches. `br 2` means "leave two enclosing
blocks", so where it lands is a fact about the nesting; after the walk
it is a byte offset, a count of values to carry and a depth to carry
them to. The interpreter then needs no label stack at all, and an `end`
that is merely closing a block costs nothing.

One approximation remains, and it is the same one SPARC makes. Slots and
locals are frame-relative and the id space is not, so a callee's slot 0
and its caller's are the same id. It is handled the same way: every
instruction naming a slot or a local reads `Res.FRAME`, and `call` and
`return` write it, which makes the dependence on the call real rather
than missing.

#### The oracle is in the test process

Every other target's reference has to be driven in a container: qemu, or
mos-sim, or the host processor through ptrace. This one's is
`WebAssembly`, which is already in the process running the tests.

Three of the four tiers therefore compare **live**, against modules
generated from a seed at the moment the test runs. Nothing is recorded,
so nothing can go stale between capturing and checking. The whole suite
is 53 tests in under a second, with no Docker and no network.

The fourth tier — the app's own corpus — is recorded, because its oracle
is **wasmtime**: a different engine, from a different vendor, with a
different compiler. Agreeing with two independent implementations is a
better claim than agreeing with one.

#### There is no lockstep, and what replaces it goes further

No engine will single-step a module and report the operand stack: V8 and
wasmtime both compile to machine code, and at that point the stack has
largely stopped existing. That is the same absence the 6502 has, and it
gets the same answer — a tier that is stronger per instruction rather
than a weaker version of the missing one.

Two things stand in for it:

- **Every operation against every edge value.** One generated module
  applies all 136 operations to every combination of the edge cases for
  their operand types — both zeros, both infinities, *both signs of
  NaN*, a subnormal, the integer extremes — writing each of 6,977
  results to its own address. A single differing byte therefore names
  the operation and both its operands, so a failure is a lookup and not
  a bisection.
- **All of linear memory, byte for byte.** The engine hands the memory
  over directly, so the final-state comparison covers the whole of the
  guest's observable state rather than the registers a harness thought
  to write down.

#### Generating the bytes is not circular

The compiled modules reach 97 of the 180 opcodes. Clang compiling
ordinary C never emits `i64.rotl`, `f64.copysign`,
`i32.reinterpret_f32`, the saturating truncations, `select`, `br_table`
or `memory.grow`, so the generator emits modules directly rather than
emitting C.

The obvious objection is that a generator using this backend's own
opcode numbers, checked against an interpreter using the same numbers,
proves nothing. It is not so: **the reference executes the byte.** If
this backend believed 0x7c was `i64.add` when it was something else, the
generator would emit 0x7c meaning add, the engine would do whatever 0x7c
actually is, and the two would disagree. The tier checks the whole
mapping from opcode to behaviour, which is more than the decode tier
asks. Between the generator, the compiled modules and the trap cases,
**178 of the 180 implemented opcodes are executed against the engine.**

#### What the probe found, and one thing it nearly missed

The decode tier was green first, as on POWER: 980 instructions across
four compiled modules, 47 distinct mnemonics, no mismatches, before a
line of semantics existed. Then the probe found four operations wrong —
all four floating-point, and all four about a single bit.

- **`max` of two zeros was inverted.** `min(+0, -0)` is `-0` and
  `max(+0, -0)` is `+0`; written as the same test with the sign flipped,
  the second is wrong. `<` and `>` consider the two zeros equal, so
  nothing else notices.
- **`min` and `max` of a NaN returned the wrong NaN.** The literal `NaN`
  is `0x7ff8…` on every platform; what the engine produces is the
  *host's* default, which on x86 is `0xfff8…` with the sign bit set.
  Since every other floating-point operation here is the host's own —
  and so gets the host's answer for free — the fix was to compute the
  default rather than write it down, which keeps the two byte-identical
  on a machine where the default is the other one.
- **`copysign` read an ordering instead of a bit.** `b < 0` is false for
  every NaN, including one whose sign bit is set, so a negative NaN
  produced a positive result.
- **`f32.add` and `f32.mul` of two NaNs depended on the host's
  scheduling.** Which NaN comes out is left open by the standard, so the
  implementation had been leaving it to `a + b` — and `+` and `*`
  commute, so the engine running the interpreter is free to reorder
  them, and with two NaNs of different signs that changes the answer. A
  simulator whose output depends on its host's instruction scheduling is
  not a simulator; the rule is now stated outright.

The third of those is the one worth keeping. The probe had NaN operands
from the start and did not catch it, because **every NaN in the seed set
was positive**. The bug surfaced in a whole generated module instead,
and shrinking that module to its first cause took four lines of
bisection. Adding the negative NaN to the seeds then caught the fourth
bug immediately. A probe is only as exhaustive as its edge cases, and
"both signs of NaN" is not a case anyone lists unprompted.

#### The libc asks for five functions

There are no system calls here. A module names the functions it wants
and the embedder supplies them, so what a program can do is a property
of the link rather than of the machine.

All fourteen corpus programs — `printf` with floats, `malloc`, `strlen`
— import the same five and no others: `fd_write`, `fd_seek`,
`fd_fdstat_get`, `fd_close`, `proc_exit`. There is no `brk` and no
`mmap`, because the heap is `memory.grow`, an instruction rather than a
call; no `set_tid_address`, no `rseq`, no auxiliary vector and no
`AT_PAGESZ`. Those last few are a fair share of the awkwardness on the
other targets -- and a loader bug in exactly that area was what held
back POWER's whole-program tier.

The one answer that needed care is `fd_seek`, which returns "this is a
pipe". Saying anything else makes the libc choose the buffering it uses
for a file, and the output then comes out in a different *order* rather
than not at all — the hardest kind of difference to notice.

All fourteen programs match wasmtime on stdout byte for byte, on the
return value and on the exit status, across 1.1 million instructions.
The floating-point `printf` path worked on the first run, which is worth
recording only because it is exactly where POWER's whole-program tier
still stops.

#### What is refused

`table.get` and `table.set` are decoded — so a disassembly is right
about them — and have no semantics. Nothing a C toolchain emits uses the
reference types, so implementing them would mean shipping something no
test here could execute. They stop the run.

Not implemented at all, and so refused by the decoder rather than
mis-decoded: SIMD, threads and atomics, exception handling, multiple
memories, and the component model. A missing encoding is refused loudly;
a wrong one would run.

`elfMachine` is zero, which is the only field of the frozen contract
that does not apply to a target. A module is its own container, there is
no registered `e_machine` to give, and inventing one would be claiming
the loader accepts something it cannot read. The 6502 looks like it
should be the exception here and is not — llvm-mos emits perfectly
ordinary ELF objects.

### POWER, as built

The prediction was condition-register fields, and that part was right
and easy. What the table did not say is that this target is the one
where writing the decoder from memory would have been fatal — and where
doing it the other way round paid for itself twice over.

#### Decode first, and it found four encoding mistakes

A previous attempt at this decoder was written from recall, read back as
confident nonsense, and was deleted. This one was checked against LLVM
*before a line of semantics existed*, which is what the shared decode
tier was promoted for. It agrees with `llvm-objdump` on **9,346
instructions across four freestanding programs and a statically linked
musl binary — 175 distinct mnemonics, zero mismatches**.

Getting there found four encoding errors, and every one was fixed by
measuring the field rather than remembering it harder:

- `isel` has a five-bit extended opcode with the condition bit it tests
  in the five above it, not a ten-bit one.
- `sradi` has nine, because the sixth bit of its shift amount had to go
  in bit 30.
- `xxpermdi` has five, for the same reason — its doubleword selector
  took the other two — and `xxswapd` is that instruction with the
  selector set to two.
- The VSX conversions follow no stride worth generalising from, so each
  is listed with the disassembly it was read off. The ones that had been
  guessed were *removed*: a missing encoding is refused loudly, a wrong
  one decodes as some other instruction and runs.

#### What the decode tier cannot catch, and what caught it

The tier says which instruction a word is. It says nothing about the
values in its fields, and the first bug after it was exactly that: the
six-bit mask boundary in the 64-bit rotates is split with its *most*
significant bit alone in bit 26 and the other five below, which is the
opposite way round from how it reads. Assembling it the other way gives
a mask that is wrong only for boundaries above 31 — so the first
program still ran 47 instructions before diverging.

Lockstep found it immediately, and four more of the same kind:

- **`rlwinm` can write sixty-four bits.** `ROTL32` delivers the rotated
  word in *both* halves of a 64-bit value and the mask is
  `MASK(MB + 32, ME + 32)` over all 64, so when MB exceeds ME the mask
  wraps through bit zero and covers the whole high half. Confining it to
  the low word is right in the common case and wrong in the one that
  matters.
- **`xsmaddadp` has its destination as the *addend*.** `XT ← (XA × XB) + XT`,
  which is what a saxpy wants; the `m` form is the other way round, and
  the two differ by eight in the opcode and by everything in the answer.
  Getting them the wrong way round produces a plausible number from the
  right three operands.
- **The Altivec registers are not a separate file.** `v0` to `v31` *are*
  vector-scalar registers 32 to 63, so `vspltisw 2, 3` writes `vs34`.
  With the offset missing, the conversion that read the result found a
  zero and every division by that constant produced an infinity.
- **The three move-to-vector forms are three instructions**: sixty-four
  bits, sign-extended word, zero-extended word. Folding them together is
  right until a negative number arrives.

`XER` also carries `CA32` and `OV32` — the carry and overflow the
operation would have produced had it been 32 bits wide — which the
reference reports and an implementation that ignores them differs on at
the first `addc`.

#### The floating-point registers are the vector registers

At `-O2` for POWER8 clang does not emit `fadd` at all. It emits
`xsadddp`: the VSX instruction operating on one element of a 128-bit
register whose low half *is* floating-point register 3. So there is one
register file here, not two, and `lfd` into `f3` followed by `xsadddp`
on `vs3` is a dependence rather than a coincidence.

Unlike SPARC's windows this aliasing is exact rather than approximate,
because it does not depend on anything dynamic — `f3` is always the top
half of `vs3` — so the resource id is simply the VSX number and the
image resolves it at decode time.

That also decides what the guest has to dump. qemu's default register
dump has the general registers, `lr`, `ctr`, `cr` and `xer`, and no
floating-point registers. On this target that is not a detail: every
`double` result lives in one. The lockstep tier therefore sees a
floating-point program's control flow and not its answers, and the
guest's own dump is what covers them.

That absence is qemu's default, not a limit: adding `fpu` to its `-d`
list prints all thirty-two, and that is how the printf bug below was
found. The lockstep tier does not use it yet. It would turn "the answer
is wrong at the end" into "the answer first went wrong here" for
floating-point code, and is the obvious next strengthening of this
target's tier.

#### The floating-point status register is refused

`FPSCR` is not modelled, and `mffs` and `mtfsf` are refused rather than
answered.

It holds two things. The sticky exception bits, which nothing the
compiler emits ever reads — across every fixture the only `mffs` was
the one the harness itself used to contain, which is why the harness no
longer dumps it. And the rounding mode, which this interpreter does not
implement: every operation rounds to nearest, so a program that set a
different mode and carried on would get answers that were quietly wrong
rather than loudly refused.

This is the same call as the 6502's cycle counter. Modelling it from
recall would have meant guessing bit positions and validating them
against one oracle; refusing it costs nothing measurable and says so.

#### The whole-program tier, and what it found

All eighteen libc and corpus programs now match qemu-ppc64le on output
and exit status, and the fourteen corpus programs compute exactly the
answers the app's own compiler recorded. POWER is in the app's lane.

The tier had been held back for three causes, each written down. They
turned out to be five bugs, and only one of the three causes was where
it had been placed.

- **The heap fault was the loader, not the page size.** The loader wrote
  a terminating back chain at the initial stack pointer — which is where
  the process ABI puts `argc`. With `argc` read as zero, musl walked
  `argv` and `envp` from the wrong place, found a NULL where the
  auxiliary vector should start, and read every entry as zero. The page
  size was the symptom: the allocator later asked `mmap` for zero bytes.
  The suspicion recorded here pointed at the auxiliary vector and was
  right about that; the cause was one line upstream.
- **printf's zeroes were `stfiwx` decoded as `stfsx`.** The two have the
  same shape: one stores the low word of a register as it is, the other
  converts a double to single precision first. They had identical table
  entries, so every integer musl produced with a float-to-integer
  conversion — every digit of every `%f` — was stored as the bit pattern
  of a float.
- **`mfocrf` returned the whole condition register.** It moves one field
  and zeroes the rest; it had been decoded as `mfcr`.
- **The vector unit**, which was the cause correctly named: eighteen
  Altivec and VSX operations, now implemented and verified below.
- **Latent decoding errors**, found on the way and unreached by anything
  that ran: `stxsdx` writing sixteen bytes instead of eight, `lxsiwzx`
  reading sixteen instead of four, `vspltish` and `vspltisb` decoded as
  `vspltisw`, the word merges decoded as a doubleword permute, `lxvw4x`
  treated as `lxvd2x` (a different element order on this byte order),
  `fres` listed as `frsp`, and `fctid`, `fctiw` and the `fri*` rounding
  family collapsed onto forms that round differently. None is in any
  binary measured here, so they are now refused rather than implemented
  without anything to check them against.

#### Why the decode tier let them through

Every one of those was admitted by the decode tier, and for the same
reason: **membership rather than equality**. The alias table said
`stfiwx` may decode as a store, `mfocrf` as `mfcr`, `xxmrghw` as
`xxpermdi` — and the check passed because the decoded operation was in
the set the name could stand for, while the *field* that separated them
was never looked at.

So the check now works by **signature**. For every operation whose
behaviour depends on a field — width, sign, register file, precision,
which condition fields, which logical operation — the decoded
instruction is turned back into the one name those fields imply, and
that must equal what LLVM printed. A load with the wrong sign flag now
fails as `lha decoded as lhz`; that was checked by making exactly that
change and watching the tier fail across seven binaries.

The tier also now covers the libc and corpus binaries, not only the
freestanding programs. That is where the vector unit is: none of the
freestanding programs reaches it, and all of the bugs above lived in
code only a libc executes.

#### The vector unit, verified

Printed output is weak evidence for vector code — an element that does
not reach the output can be wrong forever — so two freestanding programs
run every implemented vector operation on edge operands (sign bits, all
ones, equal and unequal elements, shift counts past the element width)
and store each result to its own slot of the guest dump, which is
compared with qemu's byte for byte. Two scalar stores are written over a
marker so that one writing too much shows as a marker that is gone.

Both matched first time, and both were then checked to fail: restoring
the sixteen-byte `stxsdx` and dropping the modulo from a vector shift
each made the comparison fail.

One behaviour is chosen rather than derived. `xscvdpsxws` and
`xscvdpuxws` define only word 1 of their result and leave the others
undefined; hardware and qemu both copy the word into word 0 as well, so
this does too. No program may depend on it, and matching it keeps the
two comparable on the doubleword that holds a scalar.

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

### SPARC V8, as built

The prediction was register windows, and register windows were indeed
the work — but not the part that was hard. Resolving a window-relative
register to a physical one is ten lines. What took the time was
everything around it: where the spill goes, what the reference does
while it happens, and what the frozen contract can say about any of it.

#### The window, and the one place the contract does not fit

A SPARC program sees 24 registers — eight `in`, eight `local`, eight
`out` — and `save` rotates that view rather than pushing anything. The
rotation *overlaps*: the caller's `out` registers are the callee's `in`
registers, the same physical registers under two names, which is how
arguments are passed without touching memory. The interpreter keeps the
physical file and resolves the window on every access, so execution is
exact.

The timing model is where it stops being exact, and the reason is worth
stating rather than hiding. `reads` and `writes` belong to a statically
decoded instruction, which the image caches by address; the physical
register an instruction names depends on the current window, which is
dynamic. The contract has nowhere to put that — the image is addressed
by program counter, and a retired chunk spans many windows before the
timing model walks it.

The contract was frozen deliberately and has now survived five backends
with one documented addition, so it was not reopened for a refinement to
a model whose output is already declared not to be measured. Instead,
**window registers are identified window-relative, and the window
pointer is itself a resource** that every instruction naming one reads.
That much is true of the hardware. What remains approximate is confined
to a window boundary, with the `save` between as a dependence both sides
carry.

#### What the reference does during a trap, and what it looks like

Eight windows run out. The ninth nested `save` traps, and on Linux the
kernel spills the oldest window to its stack frame. qemu-user emulates
that *inside the emulator* rather than by running guest code, so the
trace contains no handler — what it contains is the same instruction
dumped twice in a row with only `wim` changed, because qemu restarts
the translation block after taking the trap.

The parser collapses each pair and keeps the **first**, which is the
state before the trap and therefore what an interpreter has before
executing the instruction that traps, since the spill happens inside it.
Keeping the second instead fails on `wim` at the first recursion deeper
than eight frames, which is how this came to be understood.

The first end-to-end run was a useful confirmation of all of it at once:
qemu emitted 5,415 dumps for a recursive program, the interpreter
retired 5,377 instructions, and the difference was exactly the 38
duplicate pairs.

#### Four things measured rather than assumed

Each of these was read off the reference, and each would have been wrong
if guessed.

- **The initial window mask is 1, with `cwp` 0** — the window the
  process starts in is itself marked invalid, which is what stops `save`
  wrapping the whole way round and reusing the entry frame. Assuming the
  mask protected the window *below* instead makes the very first `save`
  trap.
- **The floating-point status register does not start at zero.** Its
  version field reads 1 from the first instruction, and a guest that
  stores `%fsr` sees it.
- **`-fno-pic` is required**, for the same reason MIPS needs it and by a
  different route: this target defaults to position-independent code,
  and there the assembler turns `%hi(sym)` into a GOT reference, so the
  entry stub loads a GOT *offset* into `%sp` and the first store faults.
- **The syscall numbers are the classic Unix ones** — `exit` is 1 and
  `write` is 4 — confirmed with `qemu-sparc -strace` rather than
  recalled.

#### The toolchain is three containers

`lld` cannot link 32-bit SPARC; it refuses with `unknown emulation:
elf32_sparc`. So clang compiles to objects in the codegen image, GNU
binutils links them in another, and qemu runs the result in a third.
That is what `ExternalLinker` in the fixture builder exists for, and it
is the first target to need it. clang also rejects `-march=` for this
target outright and wants `-mcpu=v8`.

#### What the randomised programs found

The decoder agreed with LLVM on all 702 instructions of the corpus at
the first attempt, and lockstep over a compiled program was clean once
the initial window mask was right. Neither of those exercised floating
point, because nothing the corpus compiles branches on a float.

The generated programs did, and found a real bug: **the floating-point
branch conditions were wrong in nine of sixteen cases.** The encoding is
not the integer one with different names on it — bit 3 selects "equal,
plus the condition" and the low three bits are a mask over less,
greater and unordered, so `fbul` is less-or-unordered and has nothing to
do with unsigned. They also found that this architecture's quiet NaN is
all mantissa bits set, `0x7fffffff`, where x86, ARM and JavaScript all
produce only the top bit.

Extending the generator to cover the tagged arithmetic, `mulscc`, the
two read-modify-write instructions and the whole floating-point set took
this backend's line coverage from 79% to 91% — and every line of that is
covered by comparison against qemu rather than by a unit test asserting
what the code already does.

#### Whole programs, on a libc that had to be chosen

All eighteen libc and corpus programs now match qemu-sparc on output and
exit status, the fourteen corpus programs compute the app's own recorded
answers, and SPARC is in the app's lane. What that took was mostly the
library, because every other Linux target here links musl and musl has
no SPARC port. The options were measured rather than assumed:

- **glibc** now requires V9 even for 32-bit code, so it would emit
  instructions a V8 machine does not have.
- **uClibc-ng** supports V8, but Buildroot can no longer build it for
  this target: a GCC change broke it (GCC bug 98784), the GCC versions
  that worked have been removed, and Buildroot 2024.02 marks 32-bit SPARC
  as having no internal toolchain.
- **picolibc** supports SPARC and builds with the same clang every other
  target is compiled with.

So it is picolibc, built by
[Dockerfile.sparc-libc](../../tools/isa/Dockerfile.sparc-libc) from
pinned, checksummed sources. picolibc is a library for machines without
an operating system, so it leaves input, output and exit to the
platform, and [tools/isa/sparc/platform/](../../tools/isa/sparc/platform/)
is that platform: a Linux-user `_start` (picolibc's own writes privileged
registers), a static heap for its `sbrk`, and five system calls. Its
console is built with `posix-console`, so `printf` reaches the kernel
through `write` rather than anything of ours.

**This is a real difference from the other targets and is stated as
one.** The instructions inside `printf`, `malloc` and the string
functions on SPARC are picolibc's, not musl's, so a comparison that
counts them is counting a different implementation of the same
functions. The lane names the library for every target for exactly this
reason.

Three things were found on the way.

- **The system-call table had `exit_group` and `writev` crossed.** 188
  is `exit_group` on 32-bit SPARC and `writev` is 121; the table had 188
  as `writev`. A program leaving through `exit_group` would have been
  treated as a vector write and kept running. Nothing had made either
  call before this target had a libc; the table is now checked against
  `unistd_32.h` from `linux-libc-dev-sparc64-cross`.
- **clang passes a `long double` through `...` wrongly on this target.**
  `va_arg(ap, long double)` in a trivial variadic function returns bytes
  of the stack instead of the value. The arithmetic is fine — one third
  is `3ffd5555…` bit for bit and three of them sum to exactly one — but
  `%Lf` cannot work, in any library, and qemu runs the same wrong code.
  The shared `mathfmt` program prints that one value through `double` on
  SPARC, behind a macro only this target defines, so every other
  target's source and output are unchanged. glibc's quad-precision
  routines were tried and removed: they would have made `%Lf` link, not
  work, at the cost of pulling LGPL code into every program that prints.
- **The decode tier, now covering the libc binaries, agreed with LLVM on
  every instruction in them**, and after the audit (*The decode audit*,
  above) that includes every branch condition, annul bit, flag-setting
  form and floating-point format, each checked by signature rather than
  by membership.

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

#### SPARC V8, measured before building

The toolchain and the oracle are both confirmed working end to end, and
four things about them shape the backend:

- **The chain is three images, not two.** `clang --target=sparc-unknown-linux-gnu
  -mcpu=v8` compiles (note `-mcpu`, not `-march`, which clang rejects for
  this target), `sparc64-linux-gnu-ld -m elf32_sparc` links, and
  `qemu-sparc` — already in `isa-sim/qemu-user:11.1.0` — runs it. A
  freestanding recursive-Fibonacci program returns the right answer
  through all three.
- **It is the first big-endian target.** `GuestMemory` already takes
  endianness as a constructor argument, which is exactly why.
- **The delay slot is architectural here, not implied.** qemu's dump
  carries `pc` *and* `npc`, so unlike MIPS the "where control goes next"
  state is named by the architecture and does not have to be
  reconstructed. The dump also carries the window-relative `%g/%o/%l/%i`
  view, `psr` with the integer condition codes, `wim`, `y` and `fsr`.
- **Window overflow traps are handled inside qemu and appear as a
  duplicated dump.** When a `save` runs out of windows, the Linux kernel
  spills to the stack; qemu-user emulates that internally, so no handler
  instructions appear in the trace. What appears instead is the *same*
  pc, npc and registers twice in a row with only `wim` changed, because
  qemu restarts the translation block after taking the trap. A lockstep
  parser that does not expect that pair will report a mismatch on every
  recursion deeper than eight frames.

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

In two places: the **eight-way comparison**, which is what the app is for,
and a **lane** of its own for looking at one target at a time.

### In the comparison

For the fourteen canned C programs, the comparison runs every target on its
real binary by default. The workload panel offers the choice — *Real ISA*
or *Model lowering* — and the real path is
[compareReal.ts](../../src/engine/compareReal.ts): for each target it loads
the binary clang compiled from that program, runs the verified interpreter,
and hands the retired instructions to the trace-driven timing model, whose
caches, branch predictor and energy accounting are the same ones the
lowering is timed with.

This was not the first design. The first kept the real backends out of the
comparison entirely, in their own lane, on the argument that a real
instruction stream in the same table as a lowered one would invite reading
both as equally real. The argument was right about mixing and wrong about
the conclusion: the fix for mixing is not to keep real results out of the
comparison, it is to make **every table one kind or the other, and say
which**. So a table is all real or all lowered, never both, and a real one
names every target by its real name, states "real instructions, modelled
timing" in its header, and gives each target's library, oracle and
verification in its protocol pane.

What keeps a real result honest is the same thing that keeps a lowered one
honest: every row answers to the IR interpreter reference, and a row whose
return value or output differs rejects the run. The one exception is
stated in the report rather than excused — the 6502's `int` is sixteen bits,
so where the answer does not fit in one it computes a different value, and
must still return one its `int` can hold. Where a target has no binary for
a program at all (`struct`, on the 6502), the others run and the report
names the gap.

The rest of the comparison's workloads stay on the lowering, and not by
choice: the app cannot compile at runtime, so the built-in IR kernels, your
own C and custom IR have no binaries. A canned program whose saved source
differs from the catalogue's is refused on the real path for the same
reason rather than run against a binary built from something else.

Saved results record which path made them. One saved before this existed
carries no mode and replays on the lowering, with its fingerprint
unchanged; a real result fingerprints differently from a lowered one of the
same program, because it is a different measurement.

### In the lane

The lane runs one target at a time and shows its disassembly, its output
and its model numbers side by side, which the comparison's table has no
room for. The claims it makes about a target are data rather than prose:
[realTargets.ts](../../src/lanes/realTargets.ts) carries the oracle's name
and how far the comparison against it goes, so a target cannot be added to
the menu without saying what verified it — and the comparison takes its
claims from the same list.

### What is shared by both

- **The programs are fixed.** The app cannot compile at runtime — the minimal
  clang image is 912 MB and needs Docker — so both run binaries built ahead
  of time. Editing the C and re-running stays a lowering feature.
- **The shipped bytes are the verified bytes.** Both load the same corpus
  files the differential suite compares against its references, not a
  rebuild of them. A test in each backend asserts that.
- **They are inlined, and loaded lazily.** The packaged app loads over
  `file://`, where fetching a sibling file is blocked, so the binaries
  become `data:` URIs in the bundle. All eight targets' worth is too much
  to put in the first chunk, so the comparison reaches them through a
  dynamic import only when a real run is asked for, and the engine itself
  never imports them: it is handed a provider and asks it for bytes. That
  is also what lets the real path be tested in Node, from the fixture files.

## 7. Running it

```
npm test                                         # includes the full differential suite
npx vite-node tools/isa/build-fixtures.ts rv64     # regenerate fixtures; needs Docker
npx vite-node tools/isa/build-fixtures.ts aarch64
npx vite-node tools/isa/build-fixtures.ts x86
npx vite-node tools/isa/build-fixtures.ts mips
```

POWER and SPARC are built the same way:

```
npx vite-node tools/isa/build-fixtures.ts power
npx vite-node tools/isa/build-fixtures.ts sparc
```

WebAssembly and the 6502 have builders of their own, because neither has
an ELF or a qemu register log to capture:

```
npx vite-node tools/isa/wasm/build-fixtures.ts   # needs Docker
npx vite-node tools/isa/mos/build-vectors.ts     # per-opcode cases; needs network
npx vite-node tools/isa/mos/build-corpus.ts      # whole programs; needs Docker
```

`build-vectors.ts` downloads about 500 MB from the SingleStepTests
repository, pinned to a commit, and writes a 1 MB sample.

Every image these use is built from a recipe in `tools/isa`, and every
download inside one is checked against a pinned SHA-256 before it is
used. None is needed to run the app or the tests -- the fixtures are
committed -- only to regenerate them. Build `codegen-min` first; the two
library images take their compiler from it, so every target is compiled
by the same binary.

```
cd tools/isa
docker build -f Dockerfile.codegen-min -t isa-bench/codegen-min:23.1.0 .
docker build -f Dockerfile.sysroot     -t isa-bench/codegen-musl:23.1.0-1.2.5-r3 .
docker build -f Dockerfile.qemu        -t isa-sim/qemu-user:11.1.0 .
docker build -f Dockerfile.native      -t isa-bench/native-x86:1 .
docker build -f Dockerfile.sparc       -t isa-sim/sparc-linker:2.40-2 .
docker build -f Dockerfile.sparc-libc  -t isa-bench/sparc-picolibc:1.8.10 .
docker build -f Dockerfile.wasi        -t isa-sim/wasi:33.0-48.0.1 .
docker build -f Dockerfile.mos         -t isa-sim/mos:23.0.1 .
```

| Image | What it is | Used for |
| --- | --- | --- |
| `codegen-min` | clang, lld, llvm-objdump and llvm-ar from the LLVM 23.1.0 release | compiling every freestanding program |
| `codegen-musl` | the above, with musl 1.2.5 and compiler-rt for five targets | the libc and corpus programs |
| `qemu-user` | qemu 11.1.0 user mode, five targets | the lockstep reference |
| `native-x86` | a ptrace tracer | x86-64's lockstep reference, on the host CPU |
| `sparc-linker` | GNU binutils for SPARC | linking, which lld cannot do for 32-bit SPARC |
| `sparc-picolibc` | picolibc 1.8.10, built with the same clang | SPARC's libc |
| `wasi` | WASI SDK 33 and wasmtime 48.0.1 | WebAssembly, and its reference |
| `mos` | the llvm-mos SDK 23.0.1 and `mos-sim` | the 6502 |

The initial stack pointer recorded in each lockstep fixture comes from
qemu and varies between captures, because qemu-user randomises it; the
programs set their own stack immediately, so it does not affect
execution, but it is why regenerating produces a diff even when nothing
else changed.
