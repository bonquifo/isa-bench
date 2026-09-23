import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C_EXAMPLES } from '../engine/c/programs.ts'
import { runRealComparisonAsync } from '../engine/compareReal.ts'
import { DEFAULT_PROFILE_ID } from '../engine/hardware.ts'
import { fixtureRealProvider } from '../engine/realProvider.node.ts'
import { IsaId } from '../engine/types.ts'
import { compilingProvider } from './provider.ts'
import { compilableTargets, Toolchain } from './toolchain.ts'

/**
 * Every program the app ships, compiled by the in-app compiler for every
 * target it compiles for, run on the verified interpreters, and held to the
 * answers the app records. For the five musl targets and the 6502 the
 * binaries must also be the shipped ones, byte for byte: the same compiler,
 * libraries and arguments can produce nothing else.
 */
const ROOT = resolve(import.meta.dirname, '../..')
const DIR = join(ROOT, 'toolchain')
const present = ['llvm.wasm', 'mos.wasm', 'sysroot.tar'].every((name) => existsSync(join(DIR, name)))

const SHIPPED: Partial<Record<IsaId, string>> = {
  [IsaId.RISCV]: 'riscv/fixtures/corpus-%s.elf', [IsaId.ARM]: 'aarch64/fixtures/corpus-%s.elf',
  [IsaId.X86]: 'x86/fixtures/corpus-%s.elf', [IsaId.MIPS]: 'mips/fixtures/corpus-%s.elf',
  [IsaId.POWER]: 'power/fixtures/corpus-%s.elf', [IsaId.MOS]: 'mos/fixtures/corpus-%s.bin',
}

/**
 * The programs the 6502 fixture builder could not build, with its reason.
 * The in-app compiler must fail on exactly these -- the same compiler
 * refusing the same program -- and build everything else.
 */
const MOS_UNBUILT = new Set<string>(
  (JSON.parse(readFileSync(join(ROOT, 'src/isa/mos/fixtures/corpus.json'), 'utf8')) as {
    skipped: { name: string }[]
  }).skipped.map((entry) => entry.name.replace(/^corpus-/, '')),
)

describe.skipIf(!present)('the in-app compiler, over the whole corpus', async () => {
  const toolchain = present
    ? new Toolchain({
      llvm: await WebAssembly.compile(readFileSync(join(DIR, 'llvm.wasm'))),
      mos: await WebAssembly.compile(readFileSync(join(DIR, 'mos.wasm'))),
      sysroot: new Uint8Array(readFileSync(join(DIR, 'sysroot.tar'))),
    })
    : null

  for (const example of C_EXAMPLES) {
    it(`${example.id}: every target, to the recorded answer`, async () => {
      const shippedBytes = new Map<IsaId, Uint8Array>()
      const result = await runRealComparisonAsync({
        workloadId: 'custom-c',
        customSource: example.source,
        n: 1,
        seed: 1,
        isas: compilableTargets(),
        hardwareMode: 'same',
        profileId: DEFAULT_PROFILE_ID,
        execution: 'real-isa',
      }, compilingProvider(fixtureRealProvider, example.source, async (isa, source, channel) => {
        const compiled = await toolchain!.compile(isa, source, channel)
        if (compiled.ok) shippedBytes.set(isa, compiled.binary)
        return compiled
      }), () => {})

      const unbuilt = MOS_UNBUILT.has(example.id)
      expect(result.execution?.unavailable.map((item) => item.isa)).toEqual(unbuilt ? [IsaId.MOS] : [])
      for (const row of result.rows) {
        if (row.matchedGold) expect(`${row.isa} ${row.result}`).toBe(`${row.isa} ${example.expectedReturn}`)
      }
      for (const [isa, pattern] of Object.entries(SHIPPED) as [IsaId, string][]) {
        if (isa === IsaId.MOS && unbuilt) continue
        const shipped = readFileSync(join(ROOT, 'src/isa', pattern.replace('%s', example.id)))
        const built = shippedBytes.get(isa)!
        expect(`${isa} ${Buffer.compare(Buffer.from(built), shipped)}`).toBe(`${isa} 0`)
      }
    })
  }
})
