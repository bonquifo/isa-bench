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
 * The in-app compiler, against the fixtures it has to reproduce.
 *
 * toolchain/ is build output (tools/isa/build-toolchain.ts, or fetched by
 * scripts/fetch-toolchain.mjs), not committed, so these run where it is
 * present and are skipped, saying why, everywhere else. Packaging refuses
 * to run without it, and CI fetches it, so no app ships untested by them.
 */
const ROOT = resolve(import.meta.dirname, '../..')
const DIR = join(ROOT, 'toolchain')
const present = ['llvm.wasm', 'mos.wasm', 'sysroot.tar'].every((name) => existsSync(join(DIR, name)))

let loaded: Promise<Toolchain> | null = null
function toolchain(): Promise<Toolchain> {
  loaded ??= (async () => new Toolchain({
    llvm: await WebAssembly.compile(readFileSync(join(DIR, 'llvm.wasm'))),
    mos: await WebAssembly.compile(readFileSync(join(DIR, 'mos.wasm'))),
    sysroot: new Uint8Array(readFileSync(join(DIR, 'sysroot.tar'))),
  }))()
  return loaded
}

/** The shipped binaries the in-app compiler must reproduce exactly. */
const SHIPPED: Partial<Record<IsaId, string>> = {
  [IsaId.RISCV]: 'riscv/fixtures/corpus-fib.elf', [IsaId.ARM]: 'aarch64/fixtures/corpus-fib.elf',
  [IsaId.X86]: 'x86/fixtures/corpus-fib.elf', [IsaId.MIPS]: 'mips/fixtures/corpus-fib.elf',
  [IsaId.POWER]: 'power/fixtures/corpus-fib.elf', [IsaId.MOS]: 'mos/fixtures/corpus-fib.bin',
}

const fib = C_EXAMPLES.find((example) => example.id === 'fib')!

describe.skipIf(!present)('the in-app compiler', () => {
  for (const [isa, path] of Object.entries(SHIPPED) as [IsaId, string][]) {
    it(`builds exactly the shipped ${isa} binary from the same source`, async () => {
      // Same compiler, same libraries, same arguments: the binary the app
      // builds must be the one the fixture builder built, byte for byte.
      const result = await (await toolchain()).compile(isa, fib.source, isa === IsaId.MOS ? 'framed' : 'stderr')
      if (!result.ok) throw new Error(`${result.stage}: ${result.message}`)
      const shipped = new Uint8Array(readFileSync(join(ROOT, 'src/isa', path)))
      expect(result.binary.length).toBe(shipped.length)
      expect(Buffer.compare(Buffer.from(result.binary), Buffer.from(shipped))).toBe(0)
    }, 120_000)
  }

  it('runs a program it compiled, on every target it compiles for, to the reference answer', async () => {
    const compiler = await toolchain()
    const source = fib.source
    const result = await runRealComparisonAsync({
      workloadId: 'custom-c',
      customSource: source,
      n: 1,
      seed: 1,
      isas: compilableTargets(),
      hardwareMode: 'same',
      profileId: DEFAULT_PROFILE_ID,
      execution: 'real-isa',
    }, compilingProvider(fixtureRealProvider, source, (isa, text, channel) =>
      compiler.compile(isa, text, channel)), () => {})
    expect(result.execution?.unavailable).toEqual([])
    expect(result.rows.map((row) => row.isa).sort()).toEqual(compilableTargets().sort())
    for (const row of result.rows) {
      expect(`${row.isa} ${row.result}`).toBe(`${row.isa} ${fib.expectedReturn}`)
      expect(row.stdout).toBe(result.stdout)
    }
  }, 600_000)

  it('reports a program clang rejects as that, with clang\'s own message', async () => {
    const result = await (await toolchain()).compile(IsaId.RISCV, 'int main(void) { return x; }')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe('compile')
    expect(result.message).toMatch(/use of undeclared identifier 'x'/)
  }, 120_000)
})

describe.skipIf(present)('the in-app compiler, where it has not been built', () => {
  it('is skipped: fetch it with `node scripts/fetch-toolchain.mjs`, or build it with `npx vite-node tools/isa/build-toolchain.ts`', () => {
    expect(present).toBe(false)
  })
})
