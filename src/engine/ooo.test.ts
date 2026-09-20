import { describe, expect, it } from 'vitest'
import { profileById } from './hardware.ts'
import { MemorySystem } from './memory-system.ts'
import { runOoOComparison } from './ooo-compare.ts'
import { simulateOoO } from './ooo.ts'
import {
  DEFAULT_OOO_PROFILE,
  OOO_ENERGY_MODEL_VERSION,
  OOO_MODEL_VERSION,
  WIDTH_ONE_OOO_PROFILE,
  validateOoOProfile,
} from './ooo-types.ts'
import { ALL_ISAS } from './types.ts'
import { generateRandomIr } from '../verify/randomIr.ts'
import { compile } from './compile.ts'
import { parseIr } from './ir.ts'
import { assignAddresses, mach } from './mach.ts'
import { InstClass, MEM_SIZE, Opcode, type Program } from './types.ts'
import { IR_REFERENCE_MODEL_VERSION } from './ir-reference.ts'

const base = {
  workloadId: 'custom',
  n: 1,
  seed: 1,
  isas: ['riscv' as const],
  hardwareMode: 'same' as const,
  profileId: 'equal-inorder',
}

describe('deterministic analytical OoO engine', () => {
  it('renames through RAW, WAW, and WAR dependencies', () => {
    const result = runOoOComparison({
      ...base,
      customSource: `
        imm r0, 3
        imm r1, 4
        add r2, r0, r1
        imm r0, 10
        mul r3, r2, r0
        add r1, r3, r2
        halt r1
      `,
    })
    expect(result.gold).toBe(77)
    expect(result.rows[0]).toMatchObject({
      result: 77,
      matchedGold: true,
      modelVersion: OOO_MODEL_VERSION,
      energyModelVersion: OOO_ENERGY_MODEL_VERSION,
      energyModelClass: 'uncalibrated-ooo-event-model',
    })
    expect(result.rows[0].counts.renamedOps).toBe(
      result.rows[0].counts.retiredOps + result.rows[0].counts.squashedOps,
    )
  })

  it('precisely suppresses a wrong-path HALT and rolls back rename state', () => {
    const result = runOoOComparison({
      ...base,
      customSource: `
        imm r0, 1
        beq r0, r0, good
        imm r1, 99
        halt r1
      good:
        imm r1, 7
        halt r1
      `,
    })
    const row = result.rows[0]
    expect(row.result).toBe(7)
    expect(row.counts.branchMispredicts).toBeGreaterThan(0)
    expect(row.counts.squashedOps + row.counts.frontendFlushedOps).toBeGreaterThan(0)
  })

  it('suppresses wrong-path stores and faults while retaining speculative work metrics', () => {
    const result = runOoOComparison({
      ...base,
      customSource: `
        imm r0, 1
        imm r1, 99
        imm r2, 4096
        imm r3, -4
        beq r0, r0, good
        stw r1, 0(r2)
        ldw r4, 0(r3)
      good:
        ldw r5, 0(r2)
        halt r5
      `,
    })
    expect(result.rows[0].result).toBe(0)
    expect(result.rows[0].counts.branchMispredicts).toBeGreaterThan(0)
    expect(result.rows[0].counts.wrongPathOps).toBeGreaterThan(0)
  })

  it('is cycle-and-counter deterministic', () => {
    const input = {
      ...base,
      workloadId: 'dot_product',
      n: 16,
      seed: 9,
      customSource: undefined,
    }
    const left = runOoOComparison(input)
    const right = runOoOComparison(input)
    expect(left.rows).toEqual(right.rows)
    expect(left.envelopes.map((item) => item.comparisonGroupKey)).toEqual(
      right.envelopes.map((item) => item.comparisonGroupKey),
    )
  })

  it('runs the width-one no-speculation profile with identical functional output', () => {
    const result = runOoOComparison({
      ...base,
      workloadId: 'checksum',
      n: 24,
      seed: 3,
      customSource: undefined,
      oooProfile: WIDTH_ONE_OOO_PROFILE,
    })
    expect(result.rows[0].matchedGold).toBe(true)
    expect(result.rows[0].profileId).toBe('ooo-width-one')
  })

  it('emits contracts-shaped analytical comparison envelopes', () => {
    const result = runOoOComparison({
      ...base,
      customSource: 'imm r0, 42\nhalt r0',
    })
    const envelope = result.envelopes[0]
    expect(envelope).toMatchObject({
      experimentKind: 'analytical-ooo',
      claimClass: 'analytical-estimate',
      evidenceClass: 'model-output',
      modelVersion: OOO_MODEL_VERSION,
    })
    expect(envelope.inputIdentity).toMatch(/^[a-f0-9]{64}$/)
    expect(envelope.comparisonGroupKey).toMatch(/^[a-f0-9]{64}$/)
    expect(envelope.metrics.map((metric) => metric.domain)).toEqual([
      'analytical-model-cycles',
      'analytical-model-nj',
    ])
  })

  it('validates capacities and deterministic request IDs', () => {
    expect(() => validateOoOProfile({
      ...DEFAULT_OOO_PROFILE,
      physicalRegisters: 32,
    })).toThrow(/at least 64/)
    const hw = profileById('equal-inorder')
    const memory = new MemorySystem(hw, new ArrayBuffer(2 << 20))
    const first = memory.instructionFetch(0, 0, 4, 0)
    const second = memory.speculativeLoad(0, 4096, 4, 0)
    expect([first.id, second.id]).toEqual([1, 2])
    memory.complete(Math.max(first.readyCycle, second.readyCycle))
    expect(memory.stats().completions).toBe(2)
    memory.assertConservation()
  })

  it('matches independently generated seeded IR on all eight target lowerings', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const generated = generateRandomIr(seed)
      const result = runOoOComparison({
        ...base,
        seed,
        isas: ALL_ISAS,
        customSource: generated.source,
      })
      expect(result.gold, `seed ${seed}`).toBe(generated.expectedReturn)
      expect(result.rows.every((row) => row.matchedGold), `seed ${seed}`).toBe(true)
    }
  })

  it('makes atomic progress for operations wider than every pipeline stage', () => {
    const insts = [
      mach({ op: Opcode.LIF, mnemonic: 'wide.lif', bytes: 4, cls: InstClass.FP, dst: 0, imm: 2.5, uops: 7 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.BR, srcA: 0, uops: 3 }),
    ]
    const program: Program = {
      isa: 'riscv',
      insts,
      codeBytes: assignAddresses(insts),
      spillSlots: 0,
      physRegsUsed: 32,
    }
    const profile = {
      ...WIDTH_ONE_OOO_PROFILE,
      fetchWidth: 2,
      decodeWidth: 2,
      renameWidth: 2,
      dispatchWidth: 1,
      issueWidth: 2,
      retireWidth: 1,
    }
    const row = simulateOoO(
      program,
      profileById('equal-inorder'),
      new ArrayBuffer(MEM_SIZE),
      { profile, maxCycles: 2_000 },
    )
    expect(row.result).toBe(2.5)
    expect(row.counts.fetchedUops).toBe(10)
    expect(row.counts.dispatchedUops).toBe(10)
    expect(row.counts.retiredUops).toBe(10)
  })

  it('does not leak a lazily-created hidden resource across repeated squashes', () => {
    const program = compile(parseIr(`
      imm r0, 0
      imm r1, 40
    loop:
      addi r0, r0, 1
      blt r0, r1, taken
      imm r2, 77
      br done
    taken:
      br loop
    done:
      halt r0
    `), 'riscv')
    const ghost = program.insts.find((inst) => inst.op === Opcode.LI && inst.imm === 77)!
    ghost.resourceWrites = ['audit.wrong-path-first-use']
    const hardware = { ...profileById('equal-inorder'), predictor: 'static' as const }
    const row = simulateOoO(program, hardware, new ArrayBuffer(MEM_SIZE), {
      profile: { ...DEFAULT_OOO_PROFILE, physicalRegisters: 64 },
      maxCycles: 20_000,
    })
    expect(row.result).toBe(40)
    expect(row.counts.branchMispredicts).toBeGreaterThan(30)
  })

  it('composites byte-exact forwarding from multiple partial stores', () => {
    const result = runOoOComparison({
      ...base,
      customSource: `
        .data 4096
        .word 287454020
        .text
        imm r0, 4096
        imm r1, 127
        stb r1, 1(r0)
        imm r2, 85
        stb r2, 2(r0)
        ldw r3, 0(r0)
        halt r3
      `,
    })
    expect(result.rows[0].result).toBe(0x11557f44)
    expect(result.rows[0].counts.forwardedBytes).toBeGreaterThanOrEqual(2)
    expect(result.rows[0].counts.partialForwardedLoads).toBeGreaterThan(0)
    expect(result.rows[0].memory.speculativeLoads).toBe(1)
  })

  it('exposes store addresses before data and bypasses known nonaliases', () => {
    const result = runOoOComparison({
      ...base,
      customSource: `
        .data 4096
        .word 9 11
        .text
        imm r0, 4096
        imm r1, 100
        imm r2, 200
        mul r3, r1, r2
        stw r3, 0(r0)
        ldw r4, 4(r0)
        halt r4
      `,
      oooProfile: {
        ...DEFAULT_OOO_PROFILE,
        fu: {
          ...DEFAULT_OOO_PROFILE.fu,
          mul: { count: 1, latency: 12, initiationInterval: 1 },
        },
      },
    })
    expect(result.rows[0].result).toBe(11)
    expect(result.rows[0].counts.storeAddressIssues).toBeGreaterThan(0)
    expect(result.rows[0].counts.nonaliasBypasses).toBeGreaterThan(0)
  })

  it('counts only owned wrong-path fills, not wrong-path hits or coalescers', () => {
    const memory = new MemorySystem(profileById('equal-inorder'), new ArrayBuffer(MEM_SIZE))
    const miss = memory.instructionFetch(0, 0, 4, 0)
    memory.markWrongPath(miss.id)
    memory.complete(miss.readyCycle)
    memory.releaseRequest(miss.id)
    const afterMiss = memory.stats().wrongPathFills
    expect(afterMiss).toBeGreaterThan(0)

    const hit = memory.instructionFetch(0, 0, 4, miss.readyCycle + 1)
    memory.complete(hit.readyCycle)
    memory.markWrongPath(hit.id)
    memory.releaseRequest(hit.id)
    expect(memory.stats().wrongPathFills).toBe(afterMiss)

    const first = memory.speculativeLoad(0, 32, 80, hit.readyCycle + 1)
    const coalesced = memory.speculativeLoad(0, 32, 80, hit.readyCycle + 1)
    memory.complete(Math.max(first.readyCycle, coalesced.readyCycle))
    memory.releaseRequest(first.id)
    memory.releaseRequest(coalesced.id)
    expect(memory.stats().coalescedLineRequests).toBeGreaterThan(0)
    memory.assertDrained()
  })

  it('fails closed when a fixed barrier participant halts early', () => {
    const program = compile(parseIr(`
      tid r0
      imm r1, 0
      beq r0, r1, wait
      halt r0
    wait:
      barrier
      halt r0
    `), 'riscv')
    expect(() => simulateOoO(
      program,
      { ...profileById('equal-quad'), cores: 2, threads: 2 },
      new ArrayBuffer(MEM_SIZE),
      { maxWorkers: 2, maxCycles: 20_000 },
    )).toThrow(/Divergent barrier epoch 0/)
  })

  it('drains per-thread stores through barriers on multiple cores', () => {
    const result = runOoOComparison({
      ...base,
      workloadId: 'int_sum',
      n: 32,
      customSource: undefined,
      profileId: 'equal-quad',
      oooProfile: { ...DEFAULT_OOO_PROFILE, storeBufferEntries: 1 },
    })
    const row = result.rows[0]
    expect(row.matchedGold).toBe(true)
    expect(row.memory.committedStores).toBeGreaterThan(1)
    expect(row.memory.requests).toBe(row.memory.completions)
    expect(row.memory.releases).toBe(row.memory.requests)
    expect(row.memory.retainedRequests).toBe(0)
    expect(row.memory.pendingLines).toBe(0)
  })

  it('keeps FU utilization bounded and makes dispatch width observable', () => {
    const insts = [
      ...Array.from({ length: 12 }, (_, index) =>
        mach({
          op: Opcode.LI,
          mnemonic: `wide.li.${index}`,
          bytes: 4,
          cls: InstClass.ALU,
          dst: index,
          imm: index,
          uops: 8,
        })),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.BR, srcA: 11 }),
    ]
    const program: Program = {
      isa: 'riscv',
      insts,
      codeBytes: assignAddresses(insts),
      spillSlots: 0,
      physRegsUsed: 32,
    }
    const wideStages = {
      ...DEFAULT_OOO_PROFILE,
      fetchWidth: 8,
      decodeWidth: 8,
      renameWidth: 8,
      issueWidth: 8,
      retireWidth: 8,
    }
    const narrow = simulateOoO(program, profileById('equal-inorder'), new ArrayBuffer(MEM_SIZE), {
      profile: { ...wideStages, dispatchWidth: 1 },
    })
    const wide = simulateOoO(program, profileById('equal-inorder'), new ArrayBuffer(MEM_SIZE), {
      profile: { ...wideStages, dispatchWidth: 8 },
    })
    expect(narrow.cycles).toBeGreaterThan(wide.cycles)
    expect(Object.values(wide.fuUtilization).every((value) =>
      value >= 0 && value <= 1)).toBe(true)
  })

  it('distinguishes FU latency from initiation interval and releases RS on issue', () => {
    const input = {
      ...base,
      customSource: `
        imm r0, 6
        imm r1, 7
        mul r2, r0, r1
        mul r3, r0, r1
        mul r4, r0, r1
        add r5, r2, r3
        add r6, r5, r4
        halt r6
      `,
    }
    const pipelined = runOoOComparison({
      ...input,
      oooProfile: {
        ...DEFAULT_OOO_PROFILE,
        fu: {
          ...DEFAULT_OOO_PROFILE.fu,
          mul: { count: 1, latency: 8, initiationInterval: 1 },
        },
      },
    }).rows[0]
    const blocked = runOoOComparison({
      ...input,
      oooProfile: {
        ...DEFAULT_OOO_PROFILE,
        fu: {
          ...DEFAULT_OOO_PROFILE.fu,
          mul: { count: 1, latency: 8, initiationInterval: 8 },
        },
      },
    }).rows[0]
    expect(pipelined.result).toBe(126)
    expect(blocked.cycles).toBeGreaterThan(pipelined.cycles)
    expect(pipelined.occupancy.rs.area).toBeLessThan(pipelined.occupancy.rob.area)
  })

  it('charges indirect-call and return-stack recovery cycles', () => {
    const result = runOoOComparison({
      ...base,
      workloadId: 'custom-c',
      customSource: `
        int seven(void) { return 7; }
        int main(void) {
          int (*fn)(void) = seven;
          return fn();
        }
      `,
      customHw: { rasDepth: 0, indirectCallPenalty: 5 },
    })
    expect(result.rows[0].result).toBe(7)
    expect(result.rows[0].counts.rasMisses).toBeGreaterThan(0)
    expect(result.rows[0].counts.indirectRecoveryCycles).toBeGreaterThanOrEqual(5)
  })

  it('references custom nthreads with the deterministic worker count on all targets', () => {
    const result = runOoOComparison({
      ...base,
      n: 2,
      isas: ALL_ISAS,
      profileId: 'equal-quad',
      customSource: '.data 393216\n.word 1 65\n.text\nnthreads r0\nhalt r0',
    })
    expect(result.gold).toBe(2)
    expect(result.referenceModelVersion).toBe(IR_REFERENCE_MODEL_VERSION)
    expect(result.rows.map((row) => row.result)).toEqual(Array(8).fill(2))
    expect(result.rows.every((row) => row.matchedGold)).toBe(true)
    expect(result.stdout).toBe('A')
    expect(result.rows.every((row) => row.stdout === 'A')).toBe(true)
  })

  it('references shared memory through a fixed-participant barrier on all targets', () => {
    const result = runOoOComparison({
      ...base,
      n: 2,
      isas: ALL_ISAS,
      profileId: 'equal-quad',
      customSource: `
        tid r0
        imm r1, 4096
        stw r0, 0(r1)
        barrier
        ldw r2, 0(r1)
        halt r2
      `,
    })
    expect(result.gold).toBe(1)
    expect(result.rows.map((row) => row.result)).toEqual(Array(8).fill(1))
    expect(result.rows.every((row) => row.stdout === '')).toBe(true)
  })

  it('uses private call stacks in the multi-worker reference', () => {
    const result = runOoOComparison({
      ...base,
      n: 2,
      isas: ALL_ISAS,
      profileId: 'equal-quad',
      customSource: `
        nthreads r0
        call copy
        halt r1
      copy:
        mov r1, r0
        ret
      `,
    })
    expect(result.gold).toBe(2)
    expect(result.rows.every((row) => row.result === 2 && row.matchedGold)).toBe(true)
  })

  it('skips speculative memory requests for fully forwarded loads', () => {
    const result = runOoOComparison({
      ...base,
      customSource: `
        imm r0, 4096
        imm r1, 287454020
        stw r1, 0(r0)
        ldw r2, 0(r0)
        halt r2
      `,
    })
    const row = result.rows[0]
    expect(row.result).toBe(287454020)
    expect(row.counts.forwardedBytes).toBe(4)
    expect(row.counts.partialForwardedLoads).toBe(0)
    expect(row.memory.speculativeLoads).toBe(0)
    expect(row.memory.requests).toBe(8)
    expect(row.cycles).toBe(174)
  })

  it('does not create fill ownership for disabled cache levels', () => {
    const baseHw = profileById('equal-inorder')
    const hardware = {
      ...baseHw,
      l1i: { ...baseHw.l1i, sizeBytes: 0 },
      l1d: { ...baseHw.l1d, sizeBytes: 0 },
      l2: { ...baseHw.l2, sizeBytes: 0 },
      l3: { ...baseHw.l3, sizeBytes: 0 },
    }
    const memory = new MemorySystem(hardware, new ArrayBuffer(MEM_SIZE))
    const request = memory.instructionFetch(0, 0, 4, 0)
    memory.markWrongPath(request.id)
    memory.complete(request.readyCycle)
    memory.releaseRequest(request.id)
    expect(memory.stats()).toMatchObject({
      requests: 1,
      completions: 1,
      releases: 1,
      dramRequests: 1,
      ownedFills: 0,
      installedFills: 0,
      wrongPathFills: 0,
      pendingLines: 0,
    })
    memory.assertDrained()
  })

  it('counts only admitted uops when a 100-uop frontend operation is squashed', () => {
    const branch = mach({
      op: Opcode.BEQ,
      mnemonic: 'taken',
      bytes: 4,
      cls: InstClass.BR,
      srcA: 0,
      srcB: 0,
    })
    branch.target = 3
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'one', bytes: 4, cls: InstClass.ALU, dst: 0, imm: 1 }),
      branch,
      mach({
        op: Opcode.LI,
        mnemonic: 'wide-wrong-path',
        bytes: 4,
        cls: InstClass.ALU,
        dst: 1,
        imm: 99,
        uops: 100,
      }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.BR, srcA: 0 }),
    ]
    const program: Program = {
      isa: 'riscv',
      insts,
      codeBytes: assignAddresses(insts),
      spillSlots: 0,
      physRegsUsed: 32,
    }
    const profile = {
      ...DEFAULT_OOO_PROFILE,
      fu: {
        ...DEFAULT_OOO_PROFILE.fu,
        br: { ...DEFAULT_OOO_PROFILE.fu.br, latency: 10 },
      },
    }
    const row = simulateOoO(
      program,
      { ...profileById('equal-inorder'), predictor: 'static' },
      new ArrayBuffer(MEM_SIZE),
      { profile, maxCycles: 2_000 },
    )
    expect(row.result).toBe(1)
    expect(row.counts.frontendFlushedOps).toBe(1)
    expect(row.cycles).toBe(119)
    expect(row.counts.frontendFlushedUops).toBe(52)
    expect(row.counts.fetchedUops).toBe(55)
    expect(row.counts.fetchedUops).toBe(
      row.counts.retiredUops +
      row.counts.squashedUops +
      row.counts.frontendFlushedUops,
    )
  })
})
