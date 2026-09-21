# Task prompt: real per-ISA interpreters for ISA Bench

Implement real instruction-set semantics so the app can execute genuinely
compiled code for each supported ISA, replacing the pseudo-backend lowering
that currently stands in for it.

Repository: `C:\ISA_SIM` (GitHub `bonquifo/isa-bench`). Start from branch
`spike/real-toolchain`, commit `e79d16d`, which contains a working spike and
the findings below. `main` is the shipping app; keep it working.

## Why this exists

ISA Bench compares the same C program across eight ISA-inspired targets. Today
those targets are *pseudo-backends*: the lowering invents mnemonics, assumes a
flat 4 bytes per instruction, and allocates from a generic register file. The
goal is for each target to run real compiled code with real semantics, real
encodings and real register pressure, so the comparison is about the ISA rather
than about a caricature of it.

A spike already proved the compiler half is cheap and found where the real
difficulty is. Read it before planning: `spike/Dockerfile.codegen-min`,
`spike/realIsa/riscv.ts`, `spike/realIsa/demo.ts`.

## What the spike already established — do not re-derive

- **One `clang` covers every target.** It registers 46. Compiling full C
  (`unsigned`, `short`, `long`, `float`, `bool`, varargs — all rejected by the
  in-house Guest C v1.4 compiler) works today for every ISA in the list.
- **The toolchain is affordable.** The original 15.8 GB image copied the whole
  extracted LLVM release into the runtime layer. clang is statically linked
  against LLVM and needs only its own builtin headers, so the runtime set is
  clang + lld + llvm-objdump + `lib/clang/23/include`:
  `docker build -f spike/Dockerfile.codegen-min -t isa-bench/codegen-min:23.1.0 spike`
  yields a 912 MB image, about 520 MB of binaries, ~157 MB compressed.
- **Disassembly converts cleanly.** `spike/realIsa/riscv.ts` parses
  `llvm-objdump -d --no-show-raw-insn` into the engine's `MachInst` stream,
  taking instruction length from consecutive addresses (so compressed RVC
  instructions count as the 2 bytes they are), architectural `x0..x31`
  registers, operation class from the real opcode, and branch targets mapped
  from byte address to instruction index.
- **The blocker is not the compiler.** `simulate()` in `src/engine/cpu.ts` is a
  *functional simulator with timing attached*, not a trace-driven timing model.
  Line 350 is `write(i32(a + b))`; branches are decided from simulated register
  values. Feed it real instructions and the loop counter never advances —
  the spike's demo ends in `riscv simulation did not halt (80000000 cycles)`.

That last point is the whole task. Real ISA support means real execution
semantics.

## Engine facts that cost real time to discover

- `simulate(program, hardwareProfile, memory, opts)` in `src/engine/cpu.ts`
  both executes and times. A program terminates on `Opcode.HALT`; compiled
  object code ends in `ret`, so something must supply a terminator or an entry
  stub.
- `inst.target` is an **instruction index**, not a byte address
  (`th.pc = inst.target`). `mach()` does not accept `target`; the engine's own
  lowering assigns it in a later label-resolution pass, and so must you.
- The engine's opcode vocabulary is small and its own — 47 entries:
  `LI LIF MOV ADD SUB MUL DIV REM AND OR XOR SHL SHR SAR ADDI ADDF SUBF MULF
  DIVF EQF NEF LTF GEF ITOD DTOI I8 LDB STB LDW STW LDD STD BEQ BNE BLT BGE BR
  HALT NOP TID PTID PNTHREADS NTHREADS CSTACK_CHECK BARRIER CALL RET ICALL`,
  with classes `alu mul div ld st br fp mov nop`. Real ISAs have hundreds of
  instructions. Reconciling the two is a core design decision, not a detail —
  see below.
- The existing `src/engine/ir-reference.ts` is an independent oracle for the
  project's own IR and shows the house style for a deterministic interpreter.
- Tests run with `npm test` (fast suite) and `npm run test:deep` (exhaustive,
  ~4 minutes). `npm run coverage` reports line coverage; the project sits at
  ~92% and 446 tests. Keep both green.

## The central design decision

Pick and justify one, in writing, before implementing:

1. **Unified interpreter over a normalised internal operation set.** Decode each
   ISA into a shared representation, execute once. Less duplicated work,
   but the normalisation is where correctness quietly dies: x86 flags, ARM
   conditional execution, RISC-V's lack of flags, SPARC register windows and
   MIPS branch delay slots do not share a natural shape.
2. **Separate interpreter per ISA, shared infrastructure.** Each ISA owns its
   decode and semantics; memory, register files, syscall emulation and the
   timing interface are shared. More code, but each interpreter can be verified
   against a real reference independently, and a bug in one cannot silently
   corrupt another.

Whichever you choose, the existing 47-opcode vocabulary is almost certainly too
narrow to carry real semantics. Decide explicitly whether to extend it, to keep
it only as a *timing class* annotation while semantics live elsewhere, or to
bypass it. State the consequence for `simulate()`.

Strongly consider decoupling execution from timing: let the interpreter produce
an executed-instruction trace and let the timing model consume it. That is the
standard architecture, it makes both halves testable in isolation, and it is
what the project's deleted gem5 integration did. If you reject it, say why.

## Correctness is the deliverable, not the interpreter

An interpreter that is subtly wrong is worse than none, because every number
downstream inherits the error and looks plausible. Differential testing against
a real reference is mandatory, not optional.

Oracles already available on this machine:

| Target | Reference |
| --- | --- |
| x86-64 | run the compiled binary natively |
| aarch64, riscv64, mipsel, ppc64le, sparc | `isa-sim/qemu-user:11.1.0`, binaries under `/opt/qemu/bin/qemu-*` |
| wasm32 | `isa-sim/wasi:33.0-48.0.1` (Wasmtime) |
| mos | `isa-sim/mos:23.0.1` (`mos-sim`) |

Requirements:

- Every interpreter is verified against its reference on **final architectural
  state**, not just the return value: general registers, and memory the program
  wrote.
- Cover the awkward cases deliberately: signed and unsigned division including
  division by zero and `INT_MIN / -1`, shift-amount masking, sign extension at
  every width, unaligned access, IEEE-754 NaN payloads and signed zero, and
  overflow/carry flag behaviour where the ISA has flags.
- Randomised differential testing over generated programs, not only fixed
  cases. Seeds must be recorded so a failure is reproducible.
- An instruction you have not implemented must **fail loudly**, never
  fall through as a no-op or a plausible default. Silent wrong answers are the
  single worst outcome here.

## Phasing — a proven vertical slice before breadth

Do not attempt eight ISAs at once; that fails. The end goal is all eight, and
the route is one proven first.

1. **RV64GC end to end.** Cleanest encoding, fixed registers, no flags, no delay
   slots, and an existing adapter to build on. Deliver: decode, semantics,
   differential verification against `qemu-riscv64`, and a real C program
   producing a correct result and a timing number through the app.
2. **Freeze the architecture.** With one ISA working, write down the interfaces
   that the remaining seven will implement. Revise now, while it is cheap.
3. **AArch64, then x86-64.** AArch64 is regular but has conditional execution
   and flags. x86-64 is variable-length, flag-heavy and enormous — scope it to
   what clang actually emits for the corpus at `-O2` rather than the whole
   architecture, and make the unimplemented set explicit and loud.
4. **MIPS32, PowerPC, SPARC V8.** Each has one structural surprise: branch delay
   slots, condition-register fields, register windows.
5. **WASM and MOS 6502 last.** Both are structurally unlike the others. MOS
   cannot support a full C library at all — 64 KB address space, 8-bit
   accumulator, no OS — so define honestly what it *can* claim rather than
   pretending parity.

## Definition of done for milestone 1

- Real C, compiled by clang for RV64, executes under the new interpreter and
  produces a result matching `qemu-riscv64` on architectural state.
- The full C language works to the extent clang and the chosen libc support it.
  State plainly which library functions are available and which are not.
- Differential tests run in CI, with recorded seeds.
- `npm test`, `npm run test:deep`, `npm run typecheck`, `npm run lint` and
  `npm run build` all pass; coverage does not regress below the current ~92%.
- A written architecture note covering the decision above, what the timing
  model now consumes, and what the remaining seven ISAs must implement.

## Constraints and traps

- Keep `main` shippable. The app currently builds a 95 MB Windows installer, a
  113 MB AppImage and a 107 MB Linux tarball, all verified. Do not regress that.
- Do not reintroduce a 25 GB dependency. The minimal image exists precisely so
  the toolchain can ship or be fetched once. If the toolchain must be
  downloaded at runtime, verify it by checksum.
- Build Linux artifacts on Linux. A tarball built on Windows loses the
  executable bit and will not start; `scripts/pack-linux-wsl.sh` exists for
  this, and CI enforces it.
- Do not claim measured hardware performance. Everything here is modelled or
  simulated; the project's honesty guarantees about that are load-bearing and
  documented in the README.
- The Guest C v1.4 compiler in `src/engine/c/` becomes redundant once clang is
  the front end. Do not delete it until the replacement is proven across the
  corpus — it is currently the only thing that works.

## First reply

Before writing code, reply with: the design decision and its justification, the
interface the timing model will consume, how the 47-opcode vocabulary is
resolved, and a concrete plan for milestone 1 including how differential
testing will be structured. Flag anything in this prompt you think is wrong —
the spike's findings are evidence, not instructions.
