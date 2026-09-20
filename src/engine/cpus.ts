import { ARM_CPUS } from './cpus_arm.ts'
import { cpu, type CpuModel } from './cpus_build.ts'
import { x86Chip } from './cpus_topo.ts'
import { chipDefaults } from './hardware.ts'
import { MIPS_CPUS } from './cpus_mips.ts'
import { MOS_CPUS } from './cpus_mos.ts'
import { POWER_CPUS } from './cpus_power.ts'
import { RISCV_CPUS } from './cpus_riscv.ts'
import { SPARC_CPUS } from './cpus_sparc.ts'
import { WASM_CPUS } from './cpus_wasm.ts'
import { X86_MODELS, X86_UARCH } from './cpus_x86.ts'
import { ALL_ISAS, ISA_META, type IsaId } from './types.ts'

export type { CpuModel } from './cpus_build.ts'

function x86Cpus(): CpuModel[] {
  return X86_MODELS.map((m) => {
    const uarch = X86_UARCH[m.uarch]
    if (!uarch) throw new Error(`Unknown x86 µarch ${m.uarch} on ${m.id}`)
    if (m.vendor !== 'Intel' && m.vendor !== 'AMD') {
      throw new Error(`${m.id} is not an Intel/AMD x86-64 part`)
    }
    const chip = x86Chip(m.id)
    return cpu(
      m.id,
      m.name,
      m.vendor,
      m.year,
      'x86',
      m.blurb,
      { ...uarch, clockMhz: m.clockMhz, ...chipDefaults(chip.cores, chip.threads) },
      m.group,
    )
  })
}

export const CPU_CATALOG: CpuModel[] = [
  ...RISCV_CPUS,
  ...ARM_CPUS,
  ...x86Cpus(),
  ...MIPS_CPUS,
  ...POWER_CPUS,
  ...SPARC_CPUS,
  ...WASM_CPUS,
  ...MOS_CPUS,
]

export const DEFAULT_CPU_ID: Record<IsaId, string> = {
  riscv: 'sifive-u74',
  arm: 'cortex-a76',
  x86: 'r9-7950x',
  mips: 'mips-74k',
  power: 'power9',
  sparc: 'usparc-iii',
  wasm: 'wasm-cranelift',
  mos: 'mos-6502',
}

export function cpuById(id: string): CpuModel {
  const found = CPU_CATALOG.find((c) => c.id === id)
  if (!found) throw new Error(`Unknown CPU "${id}"`)
  return found
}

export function cpusForIsa(isa: IsaId): CpuModel[] {
  return CPU_CATALOG.filter((c) => c.isa === isa)
}

export function groupCpus(cpus: CpuModel[]): { group: string; items: CpuModel[] }[] {
  if (cpus.every((c) => !c.group)) return [{ group: '', items: cpus }]
  const groups: { group: string; items: CpuModel[] }[] = []
  const index = new Map<string, CpuModel[]>()
  for (const model of cpus) {
    const key = model.group ?? model.vendor
    let items = index.get(key)
    if (!items) {
      items = []
      index.set(key, items)
      groups.push({ group: key, items })
    }
    items.push(model)
  }
  return groups
}

export function cpuSupportsIsa(cpu: CpuModel, isa: IsaId): boolean {
  return cpu.isa === isa
}

export function defaultCpuByIsa(): Record<IsaId, string> {
  return { ...DEFAULT_CPU_ID }
}

export function assertCpuCatalog(): void {
  for (const isa of ALL_ISAS) {
    const list = cpusForIsa(isa)
    if (list.length === 0) throw new Error(`No CPUs registered for ${ISA_META[isa].short}`)
    if (!list.some((c) => c.id === DEFAULT_CPU_ID[isa])) {
      throw new Error(`Default CPU ${DEFAULT_CPU_ID[isa]} missing for ${isa}`)
    }
  }
  const ids = new Set<string>()
  for (const model of CPU_CATALOG) {
    if (ids.has(model.id)) throw new Error(`Duplicate CPU id ${model.id}`)
    ids.add(model.id)
    if (model.profile.issueWidth < 1) throw new Error(`${model.id} issueWidth`)
    if (model.profile.clockMhz < 1) throw new Error(`${model.id} clock`)
    if (model.profile.cores < 1) throw new Error(`${model.id} cores`)
    if (model.profile.threads < model.profile.cores) throw new Error(`${model.id} threads`)
  }
}

assertCpuCatalog()
