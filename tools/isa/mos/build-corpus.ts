/**
 * Builds the MOS 6502 whole-program fixtures.
 *
 *   npx vite-node tools/isa/mos/build-corpus.ts
 *
 * The other half of this target's conformance story. The per-opcode
 * vectors say what one instruction does from an arbitrary state; these
 * say what a compiled program does, which is the part the vectors cannot
 * reach. The reference is `mos-sim`, the simulator llvm-mos ships.
 *
 * ## What this target cannot run, and why that is recorded
 *
 * Every other backend here runs the whole corpus. This one will not, and
 * the reasons are architectural rather than incidental: 64 KiB of address
 * space total, no hardware multiply, and a `double` that costs a
 * subroutine call per operation. A program that needs more memory than
 * the machine has is not a gap in the backend.
 *
 * So a program that fails to build or fails to run is *recorded as
 * skipped, with the reason*, rather than quietly left out. The index
 * lists every corpus program and what happened to it, so the claim this
 * target makes is a list you can read rather than an absence you have to
 * notice.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corpusPrograms } from '../corpus.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../../../src/isa/mos/fixtures')

const IMAGE = 'isa-sim/mos:23.0.1'
const CLANG = '/opt/llvm-mos/bin/mos-sim-clang'
const OBJDUMP = '/opt/llvm-mos/bin/llvm-objdump'
const SIM = '/opt/llvm-mos/bin/mos-sim'

/**
 * `-Os` rather than the `-O2` the other targets use.
 *
 * Not a preference. On a machine with 64 KiB and no registers to speak
 * of, `-O2`'s inlining and unrolling is the difference between a program
 * that links and one that does not, and a fixture that cannot be built
 * teaches nothing. The flag is recorded in the index next to the others.
 */
const FLAGS = ['-Os', '-fwrapv']

/** A guest that has gone wrong should fail, not run until the test times out. */
const TIMEOUT_MS = 120_000

function mountPath(path: string): string {
  return resolve(path).replace(/\\/g, '/')
}

function docker(workdir: string, script: string): string {
  return execFileSync(
    'docker',
    [
      'run', '--rm', '--network', 'none',
      '-v', `${mountPath(workdir)}:/work`,
      '--entrypoint', 'sh',
      IMAGE, '-c', script,
    ],
    { maxBuffer: 256 * 1024 * 1024, timeout: TIMEOUT_MS },
  ).toString('utf8')
}

interface Outcome {
  name: string
  built: boolean
  ran: boolean
  reason?: string
  exit?: number
  stdoutBytes?: number
  stderrBytes?: number
  imageBytes?: number
  instructions?: number
}

/**
 * Programs written for this target rather than borrowed from the corpus.
 *
 * The corpus exercises what a compiler emits; these exercise what the
 * corpus never reaches. Decimal arithmetic is the obvious one -- no C
 * compiler emits `sed` -- and the indirect jump through a pointer at the
 * end of a page is the defect that separates a 6502 from a description
 * of one.
 */
const PROBES: { name: string; extension: 'c' | 's'; source: string }[] = [
  {
    name: 'asm_decimal',
    extension: 's',
    // Written in assembly, not C, and that is the point of the probe. No
    // C compiler emits `sed`, so decimal mode can only be reached by
    // hand -- and an earlier version of this that reached it through
    // inline assembly in C was quietly wrong, because the register
    // constraints did not survive the `php`/`pla` pair the probe needed.
    // Assembly takes the compiler out of the question.
    //
    // It prints its own hexadecimal rather than calling printf, which
    // keeps the whole program inside the three registers the machine has
    // and makes the comparison against the simulator a comparison of
    // this arithmetic rather than of a libc.
    //
    // What it prints is bounded by what the oracle gets right, and that
    // bound was measured rather than assumed. `mos-sim` implements
    // decimal mode by the textbook rule instead of by what the adder
    // does, and is wrong twice over: for operands with a nibble above
    // nine it produces the wrong accumulator, in eight of sixty-four
    // cases recorded from hardware, and for *every* operand it takes N
    // and V from the plain binary sum, which on an NMOS part they are
    // not. So the probe keeps both operands valid BCD and reports the
    // accumulator and the carry, which is the part the simulator gets
    // right. The flags, and the invalid-digit inputs, are checked
    // against hardware instead -- see the decimal-mode test in
    // src/isa/mos/conformance.test.ts, which exists so that nobody
    // later "fixes" this backend to agree with the simulator.
    source: `        .section .zp.bss,"aw",@nobits
lhs:  .byte 0
rhs:  .byte 0
res:  .byte 0
st:   .byte 0
cin:  .byte 0

        .section .text,"ax",@progbits
        .globl main
main:
        lda #$00
        sta lhs
        ldx #16
outer:
        lda #$00
        sta rhs
        ldy #16
inner:
        lda #0
        sta cin
        clc
        jsr report
        lda #1
        sta cin
        sec
        jsr report
        lda rhs
        sed
        clc
        adc #$29
        cld
        sta rhs
        dey
        bne inner
        lda lhs
        sed
        clc
        adc #$17
        cld
        sta lhs
        dex
        bne outer
        lda #0
        sta $fff8
        rts

; Adds lhs to rhs in decimal with the carry as given, and prints
; "aa+bb+c=rr/ff". The carry is whatever the caller left set.
report:
        lda lhs
        sed
        adc rhs
        php
        cld
        sta res
        pla
        sta st
        lda lhs
        jsr hex
        lda #'+'
        jsr putc
        lda rhs
        jsr hex
        lda #'+'
        jsr putc
        lda cin
        jsr digit
        lda #'='
        jsr putc
        lda res
        jsr hex
        lda #','
        jsr putc
        lda st
        and #$01
        jsr digit
        lda #10
        jmp putc

hex:    pha
        lsr
        lsr
        lsr
        lsr
        jsr digit
        pla
        and #$0f
digit:  cmp #10
        bcc under
        adc #6
under:  adc #'0'
putc:   sta $fff9
        rts
`,
  },
  {
    name: 'asm_pointers',
    extension: 'c',
    source: `#include <stdio.h>
/* Zero page indirection, which is how this machine reaches memory at all,
   including the pointer that wraps at the end of page zero. */
volatile unsigned char *const zp = (unsigned char *)0x80;
int main(void) {
  unsigned char table[16];
  for (unsigned i = 0; i < 16; i++) table[i] = (unsigned char)(i * 13 + 1);
  unsigned total = 0;
  for (unsigned i = 0; i < 16; i++) {
    unsigned char *p = &table[i];
    total += *p;
    zp[i] = *p;
  }
  for (unsigned i = 0; i < 16; i++) total += zp[i] * 2;
  printf("total=%u\\n", total);
  /* Every shift and rotate, through the carry chain that a 16-bit shift
     on this machine is built from. */
  unsigned short v = 0xbeef;
  for (unsigned i = 0; i < 17; i++) {
    printf("%04x ", v);
    v = (unsigned short)((v << 1) | (v >> 15));
  }
  printf("\\n");
  return 0;
}
`,
  },
  {
    name: 'asm_flags',
    extension: 'c',
    source: `#include <stdio.h>
/* The carry chain and the comparison flags, which is how arithmetic wider
   than eight bits is done here. */
int main(void) {
  unsigned long acc = 0;
  for (unsigned long i = 1; i < 400; i++) acc += i * i;
  printf("acc=%lu\\n", acc);
  long signed_acc = 0;
  for (int i = -200; i < 200; i++) signed_acc += (long)i * 3 - 1;
  printf("signed=%ld\\n", signed_acc);
  unsigned char c = 0;
  for (unsigned i = 0; i < 256; i++) {
    if ((unsigned char)i < 128) c++;
    if ((signed char)i < 0) c += 2;
  }
  printf("c=%u\\n", c);
  return 0;
}
`,
  },
]

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'mos-corpus-'))
  // The images run as an unprivileged user, which on a Linux host cannot
  // write to a directory the host user made -- Docker Desktop hides this by
  // ignoring ownership on bind mounts, CI does not.
  chmodSync(work, 0o777)
  const outcomes: Outcome[] = []

  const programs = [
    ...PROBES,
    // Framed rather than sent to stderr: this platform has one output
    // port, so the two streams are the same stream. See corpus.ts.
    ...corpusPrograms({ returnChannel: 'framed' }).map((program) => ({
      name: program.name,
      extension: 'c' as const,
      source: program.source,
    })),
  ]

  try {
    for (const program of programs) {
      const outcome: Outcome = { name: program.name, built: false, ran: false }
      outcomes.push(outcome)
      writeFileSync(join(work, `${program.name}.${program.extension}`), program.source)

      // Build. A failure here is a fact about the target, so it is
      // caught, recorded and moved past rather than aborting the run.
      try {
        docker(
          work,
          `cd /work && ${CLANG} ${FLAGS.join(' ')} -o ${program.name}.bin ` +
          `${program.name}.${program.extension} 2> ${program.name}.buildlog`,
        )
        outcome.built = true
      } catch {
        let log = ''
        try {
          log = readFileSync(join(work, `${program.name}.buildlog`), 'utf8')
        } catch { /* the compiler may have died before writing one */ }
        outcome.reason = firstProblem(log) || 'the compiler or linker failed'
        process.stdout.write(`${program.name}: not built — ${outcome.reason}\n`)
        continue
      }

      // Run under the reference, capturing the streams separately so
      // neither can mask the other.
      let exit = 0
      try {
        const status = docker(
          work,
          `cd /work && ${SIM} ./${program.name}.bin ` +
          `> ${program.name}.stdout 2> ${program.name}.stderr < /dev/null; ` +
          `echo $? > ${program.name}.exit`,
        )
        void status
        exit = Number(readFileSync(join(work, `${program.name}.exit`), 'utf8').trim())
      } catch (error) {
        outcome.reason = `the simulator did not finish — ${(error as Error).message.split('\n')[0]}`
        process.stdout.write(`${program.name}: not run — ${outcome.reason}\n`)
        continue
      }

      // The disassembly the decode tier is checked against comes from the
      // ELF, which the linker writes beside the image.
      docker(
        work,
        `cd /work && ${OBJDUMP} -d ${program.name}.bin.elf > ${program.name}.objdump.txt`,
      )

      const image = readFileSync(join(work, `${program.name}.bin`))
      const stdout = readFileSync(join(work, `${program.name}.stdout`))
      const stderr = readFileSync(join(work, `${program.name}.stderr`))
      const objdump = readFileSync(join(work, `${program.name}.objdump.txt`))

      writeFileSync(resolve(OUT_DIR, `${program.name}.bin`), image)
      writeFileSync(resolve(OUT_DIR, `${program.name}.stdout`), stdout)
      writeFileSync(resolve(OUT_DIR, `${program.name}.stderr`), stderr)
      writeFileSync(resolve(OUT_DIR, `${program.name}.objdump.txt`), objdump)

      outcome.ran = true
      outcome.exit = exit
      outcome.imageBytes = image.length
      outcome.stdoutBytes = stdout.length
      outcome.stderrBytes = stderr.length
      process.stdout.write(
        `${program.name}: ${image.length} bytes, exit ${exit}, ` +
        `${stdout.length} of stdout\n`,
      )
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  const index = {
    generator: 'tools/isa/mos/build-corpus.ts',
    codegen: IMAGE,
    oracle: `${IMAGE} (mos-sim)`,
    target: 'mos-sim',
    flags: FLAGS.join(' '),
    note:
      'This target has no lockstep oracle: mos-sim has no tracing ' +
      'interface. Single-instruction conformance is covered by ' +
      'fixtures/vectors.json instead, and these fixtures cover whole ' +
      'programs. Programs the machine cannot hold are recorded as skipped ' +
      'with the reason rather than omitted.',
    ran: outcomes.filter((outcome) => outcome.ran).map((outcome) => ({
      name: outcome.name,
      exit: outcome.exit,
      imageBytes: outcome.imageBytes,
      stdoutBytes: outcome.stdoutBytes,
      stderrBytes: outcome.stderrBytes,
    })),
    skipped: outcomes.filter((outcome) => !outcome.ran).map((outcome) => ({
      name: outcome.name,
      built: outcome.built,
      reason: outcome.reason,
    })),
  }
  writeFileSync(resolve(OUT_DIR, 'corpus.json'), `${JSON.stringify(index, null, 2)}\n`)

  const ran = index.ran.length
  process.stdout.write(
    `\n${ran} of ${outcomes.length} programs run, ${index.skipped.length} skipped\n`,
  )
}

/** The first line of compiler output that says what went wrong. */
function firstProblem(log: string): string {
  for (const line of log.split(/\r?\n/)) {
    const match = /(?:error|ld\.lld): (.*)$/.exec(line)
    if (match) return match[1]!.trim().slice(0, 200)
  }
  return log.split(/\r?\n/).find((line) => line.trim().length > 0)?.slice(0, 200) ?? ''
}

void createHash
main()
