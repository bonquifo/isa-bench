/**
 * RV64GC as a fixture target.
 *
 * The first of eight, and the one whose shape the FixtureTarget interface was
 * drawn from. Everything architecture-specific about capturing a reference
 * trace for RISC-V is here.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FixtureTarget, LockstepStep } from '../fixture-builder.ts'
import { generateRandomProgram } from '../rv64/random.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const ROOT = resolve(TOOLS, '../..')

/**
 * Parses `qemu-riscv64 -d in_asm,cpu,nochain -one-insn-per-tb` output.
 *
 * Only the cpu blocks form the trace. `in_asm` is emitted once per
 * translation and `cpu` once per execution, so in a loop the disassembly
 * appears once while the register dump appears on every iteration; treating
 * the two as parallel would silently drop every instruction after the first
 * pass through any loop.
 *
 * The register lines look like:
 *   " x0/zero  0 x1/ra    111d8 x2/sp    7ffffff0 x3/gp    0"
 * and a block ends when x31 has been seen.
 */
export function parseRiscvCpuLog(text: string): LockstepStep[] {
  const steps: LockstepStep[] = []
  let pending: LockstepStep | null = null

  for (const line of text.split(/\r?\n/)) {
    const pc = /^\s*pc\s+([0-9a-f]+)\s*$/.exec(line)
    if (pc) {
      pending = { pc: BigInt(`0x${pc[1]!}`), x: Array.from({ length: 32 }, () => 0n) }
      steps.push(pending)
      continue
    }
    if (!pending) continue
    const registers = [...line.matchAll(/x(\d{1,2})\/\w+\s+([0-9a-f]+)/g)]
    if (registers.length === 0) continue
    for (const match of registers) pending.x[Number(match[1]!)] = BigInt(`0x${match[2]!}`)
    if (registers.some((m) => Number(m[1]!) === 31)) pending = null
  }
  return steps
}

/**
 * Seeds for the randomised programs. Fixed rather than drawn at build time so
 * that regenerating reproduces the same programs, and so that a failure is
 * named by its seed. Adding a seed adds coverage without disturbing anything
 * already committed.
 */
const RANDOM_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]

export const rv64Target: FixtureTarget = {
  id: 'rv64',
  codegen: 'isa-bench/codegen-min:23.1.0',
  oracle: 'isa-sim/qemu-user:11.1.0',
  qemu: '/opt/qemu/bin/qemu-riscv64',
  triple: 'riscv64-unknown-linux-gnu',
  march: 'rv64gc',
  harnessDir: join(TOOLS, 'rv64'),
  programsDir: join(TOOLS, 'rv64/programs'),
  outDir: join(ROOT, 'src/isa/riscv/fixtures'),
  workDir: join(ROOT, 'node_modules/.tmp/isa-fixtures/rv64'),
  /** Keep in sync with ISA_DUMP_BYTES in tools/isa/rv64/harness.h. */
  dumpBytes: 1552,
  gprCount: 32,
  randomSeeds: RANDOM_SEEDS,
  randomGenerator: 'tools/isa/rv64/random.ts',
  generateRandom: (seed: number) => generateRandomProgram(seed),
  parseCpuLog: parseRiscvCpuLog,
}
