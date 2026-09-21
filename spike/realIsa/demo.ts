/**
 * End-to-end spike: real C -> real clang -> real RV64 instructions -> the
 * engine's existing in-order timing model.
 *
 *   npx vite-node spike/realIsa/demo.ts
 *
 * Requires the minimal codegen image:
 *   docker build -f spike/Dockerfile.codegen-min -t isa-bench/codegen-min:23.1.0 spike
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulate } from '../../src/engine/cpu.ts'
import { HARDWARE_PROFILES } from '../../src/engine/hardware.ts'
import { InstClass, IsaId, MEM_SIZE, Opcode, type Program } from '../../src/engine/types.ts'
import { mach } from '../../src/engine/mach.ts'
import { parseDisasm, toMachInsts } from './riscv.ts'

const IMAGE = 'isa-bench/codegen-min:23.1.0'
const TARGET = 'riscv64-unknown-linux-gnu'

/* Ordinary C. Every type here is rejected by Guest C v1.4. */
const SOURCE = `
#include <stdint.h>
#include <stdbool.h>

unsigned long long dot(const short *a, const short *b, unsigned n) {
  unsigned long long acc = 0;
  for (unsigned i = 0; i < n; i++) {
    acc += (unsigned long long)((int)a[i] * (int)b[i]);
  }
  return acc;
}
`

function docker(workdir: string, argv: string[]): string {
  return execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '65532:65532',
    '-v', `${workdir}:/artifacts`, '--entrypoint', argv[0]!, IMAGE, ...argv.slice(1),
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const work = mkdtempSync(join(tmpdir(), 'isa-spike-'))
try {
  writeFileSync(join(work, 'k.c'), SOURCE)

  console.log('1. compiling real C for', TARGET)
  docker(work, ['clang', '-target', TARGET, '-O2', '-c', '-o', '/artifacts/k.o', '/artifacts/k.c'])

  console.log('2. disassembling the real object')
  const disasm = docker(work, ['llvm-objdump', '-d', '--no-show-raw-insn', '/artifacts/k.o'])
  const lines = parseDisasm(disasm)

  console.log('3. converting to the engine instruction stream')
  // The model runs a self-contained program and stops on HALT. Compiled object
  // code ends in `ret` to its caller, so the spike appends the terminator the
  // model needs. A real integration would link a tiny entry stub instead.
  const insts = [
    ...toMachInsts(lines),
    mach({ op: Opcode.HALT, mnemonic: 'unimp  # halt a0', bytes: 4, cls: InstClass.NOP, srcA: 10 }),
  ]
  const codeBytes = lines.reduce((total, line) => total + line.bytes, 0)
  const program: Program = {
    isa: IsaId.RISCV,
    insts,
    codeBytes,
    spillSlots: 0,
    physRegsUsed: new Set(insts.flatMap((i) => [i.dst, i.srcA, i.srcB]).filter((r) => r >= 0)).size,
  }

  const widths = new Map<number, number>()
  for (const line of lines) widths.set(line.bytes, (widths.get(line.bytes) ?? 0) + 1)
  const classes = new Map<string, number>()
  for (const inst of insts) classes.set(inst.cls, (classes.get(inst.cls) ?? 0) + 1)

  console.log('')
  console.log('4. what the real encoding gives that the model currently assumes')
  console.log('   real instructions        :', lines.length)
  console.log('   real code size           :', codeBytes, 'bytes')
  console.log('   model would assume       :', lines.length * 4, 'bytes (flat 4B/instruction)')
  console.log('   instruction widths       :',
    [...widths.entries()].sort().map(([b, n]) => `${n} x ${b}B`).join('   '))
  console.log('   architectural regs used  :', program.physRegsUsed, 'of 32')
  console.log('   class mix                :',
    [...classes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join('  '))

  console.log('')
  console.log('   first real instructions:')
  for (const inst of insts.slice(0, 8)) console.log('     ', inst.mnemonic)

  console.log('')
  console.log('5. feeding them to the timing model')
  const profile = HARDWARE_PROFILES.find((p) => p.id === 'equal-inorder')!
  try {
    const metrics = simulate(program, profile, new ArrayBuffer(MEM_SIZE), { maxWorkers: 1 })
    console.log('   model cycles             :', metrics.cycles)
  } catch (error) {
    console.log('   BLOCKED:', error instanceof Error ? error.message : String(error))
    console.log('')
    console.log('   simulate() is a functional simulator, not a trace-driven timing model:')
    console.log('   it evaluates every operation (cpu.ts:350 is write(i32(a + b))) and')
    console.log('   decides branches from simulated register values. Real RV64')
    console.log('   instructions carry immediates and semantics it has no cases for, so')
    console.log('   the loop counter never advances and the program never halts.')
    console.log('')
    console.log('   Real ISA support therefore needs one of:')
    console.log('     a) real semantics per instruction per ISA - an RV64, AArch64 and')
    console.log('        x86-64 interpreter each, far larger than adding a compiler; or')
    console.log('     b) decoupling timing from execution: drive the model from an')
    console.log('        execution trace produced by QEMU or gem5, which is what the')
    console.log('        deleted research-simulator lane already did.')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
