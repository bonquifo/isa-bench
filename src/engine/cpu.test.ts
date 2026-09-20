import { describe, expect, it } from 'vitest'
import { compile } from './compile.ts'
import { simulate } from './cpu.ts'
import { profileById, overlayCustom } from './hardware.ts'
import { applyData, evalBin, parseIr } from './ir.ts'
import { assignAddresses, mach } from './mach.ts'
import { ALL_ISAS, InstClass, IsaId, Opcode, type HardwareProfile, type Program } from './types.ts'

function hw(patch: Partial<HardwareProfile> = {}): HardwareProfile {
  return overlayCustom(profileById('equal-inorder'), {
    memLatency: 0,
    l2Latency: 0,
    l3Latency: 0,
    l2: { sizeBytes: 0, ways: 1, lineBytes: 64 },
    l3: { sizeBytes: 0, ways: 1, lineBytes: 64 },
    predictor: 'none',
    mispredictPenalty: 0,
    ...patch,
  })
}

function run(src: string, patch: Partial<HardwareProfile> = {}, isa: IsaId = IsaId.RISCV) {
  const ir = parseIr(src)
  const program = compile(ir, isa)
  const mem = new ArrayBuffer(1 << 20)
  applyData(mem, ir.data)
  return simulate(program, hw(patch), mem)
}

function hand(insts: Program['insts'], isa: IsaId = IsaId.RISCV): Program {
  assignAddresses(insts)
  return {
    isa,
    insts,
    codeBytes: insts.reduce((n, i) => n + i.bytes, 0),
    spillSlots: 0,
    physRegsUsed: 4,
  }
}

describe('global virtual-register call semantics', () => {
  it('matches direct, indirect, nested, and recursive callee definitions on every target', () => {
    const cases = [
      `imm r0, 1
       call f
       halt r0
       f: imm r0, 2
       ret`,
      `imm r0, 1
       la r1, f
       icall r1
       halt r0
       f: imm r0, 2
       ret`,
      `imm r0, 1
       call f
       halt r0
       f: call g
       ret
       g: imm r0, 3
       ret`,
      `imm r0, 3
       imm r1, 0
       call f
       halt r0
       f: beq r0, r1, done
       addi r0, r0, -1
       call f
       done: ret`,
    ]
    const expected = [2, 2, 3, 0]
    for (const isa of ALL_ISAS) {
      for (let i = 0; i < cases.length; i++) {
        expect(run(cases[i], {}, isa).result, `${isa} case ${i}`).toBe(expected[i])
      }
    }
  })

  it('still protects a distinct caller virtual across a call', () => {
    const src = `imm r0, 7
      call f
      halt r0
      f: imm r1, 99
      ret`
    for (const isa of ALL_ISAS) expect(run(src, {}, isa).result, isa).toBe(7)
  })
})

describe('in-order scoreboard', () => {
  it('preserves every integer and FP binop across all destination alias matrices', () => {
    const ops = ['add', 'sub', 'mul', 'div', 'rem', 'and', 'or', 'xor', 'shl', 'shr', 'sar',
      'addf', 'subf', 'mulf', 'divf'] as const
    for (const isa of ALL_ISAS) {
      for (const op of ops) {
        const fp = op.endsWith('f')
        const a = fp ? 9.5 : 20
        const b = fp ? 2.5 : 3
        const matrices = [
          { name: 'distinct', dst: 'r2', left: 'r0', right: 'r1', av: a, bv: b },
          { name: 'dst=a', dst: 'r0', left: 'r0', right: 'r1', av: a, bv: b },
          { name: 'dst=b', dst: 'r1', left: 'r0', right: 'r1', av: a, bv: b },
          { name: 'a=b', dst: 'r2', left: 'r0', right: 'r0', av: a, bv: a },
          { name: 'all same', dst: 'r0', left: 'r0', right: 'r0', av: a, bv: a },
        ]
        for (const matrix of matrices) {
          const src = `${fp ? 'immf' : 'imm'} r0, ${a}
            ${fp ? 'immf' : 'imm'} r1, ${b}
            ${op} ${matrix.dst}, ${matrix.left}, ${matrix.right}
            halt ${matrix.dst}`
          expect(run(src, {}, isa).result, `${isa} ${op} ${matrix.name}`)
            .toBe(evalBin(op, matrix.av, matrix.bv))
        }
      }
    }
  })

  it('preserves caller-live values for direct, nested, recursive, and indirect calls', () => {
    const cases = [
      `imm r0, 41
       call leaf
       addi r1, r0, 1
       halt r1
       leaf: imm r8, 99
       ret`,
      `imm r0, 41
       call outer
       addi r1, r0, 1
       halt r1
       outer: call inner
       ret
       inner: imm r8, 99
       ret`,
      `imm r0, 4
       imm r5, 42
       call rec
       halt r5
       rec: imm r1, 0
       beq r0, r1, base
       addi r0, r0, -1
       call rec
       ret
       base: ret`,
      `imm r0, 41
       la r2, leaf
       icall r2
       addi r1, r0, 1
       halt r1
       leaf: imm r8, 99
       ret`,
    ]
    for (const isa of ALL_ISAS) {
      for (const src of cases) expect(run(src, {}, isa).result, isa).toBe(42)
    }
  })

  it('returns after the CALL position within a wide issue group', () => {
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'li r5, 7', bytes: 4, cls: InstClass.ALU, dst: 5, imm: 7 }),
      mach({ op: Opcode.CALL, mnemonic: 'call leaf', bytes: 4, cls: InstClass.BR }),
      mach({ op: Opcode.HALT, mnemonic: 'halt r5', bytes: 4, cls: InstClass.NOP, srcA: 5 }),
      mach({ op: Opcode.HALT, mnemonic: 'bad', bytes: 4, cls: InstClass.NOP }),
      mach({ op: Opcode.RET, mnemonic: 'ret', bytes: 4, cls: InstClass.BR }),
    ]
    insts[1].target = 4
    const out = simulate(
      hand(insts),
      hw({ issueWidth: 4, aluCount: 4, fetchWidth: 32 }),
      new ArrayBuffer(1 << 20),
    )
    expect(out.result).toBe(7)

    const indirect = [
      mach({ op: Opcode.LI, mnemonic: 'li fn, 5', bytes: 4, cls: InstClass.ALU, dst: 6, imm: 5 }),
      mach({ op: Opcode.LI, mnemonic: 'li r5, 9', bytes: 4, cls: InstClass.ALU, dst: 5, imm: 9 }),
      mach({ op: Opcode.ICALL, mnemonic: 'icall fn', bytes: 4, cls: InstClass.BR, srcA: 6 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt r5', bytes: 4, cls: InstClass.NOP, srcA: 5 }),
      mach({ op: Opcode.HALT, mnemonic: 'bad', bytes: 4, cls: InstClass.NOP }),
      mach({ op: Opcode.RET, mnemonic: 'ret', bytes: 4, cls: InstClass.BR }),
    ]
    const indirectOut = simulate(
      hand(indirect),
      hw({ issueWidth: 4, aluCount: 4, fetchWidth: 32 }),
      new ArrayBuffer(1 << 20),
    )
    expect(indirectOut.result).toBe(9)
  })

  it('keeps spill storage isolated across SPMD workers', () => {
    const defs = Array.from({ length: 10 }, (_, i) => `addi r${i + 3}, r0, ${i + 1}`).join('\n')
    const adds = Array.from({ length: 9 }, (_, i) => `add r3, r3, r${i + 4}`).join('\n')
    const src = `tid r0
      imm r1, 4096
      ${defs}
      ${adds}
      stw r3, 0(r1,r0,4)
      halt r3`
    const ir = parseIr(src)
    const program = compile(ir, IsaId.MOS)
    expect(program.spillSlots).toBeGreaterThan(0)
    const mem = new ArrayBuffer(1 << 20)
    simulate(program, hw({ cores: 4, threads: 4 }), mem, { maxWorkers: 4 })
    const view = new DataView(mem)
    for (let tid = 0; tid < 4; tid++) {
      expect(view.getInt32(4096 + tid * 4, true)).toBe(10 * tid + 55)
    }
  })

  it('uses the pre-execution effective address for cache accounting', () => {
    const mem = new ArrayBuffer(1 << 20)
    new DataView(mem).setInt32(4096, 8192, true)
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'li r5, 4096', bytes: 4, cls: InstClass.ALU, dst: 5, imm: 4096 }),
      mach({ op: Opcode.LDW, mnemonic: 'lw r6, 0(r5)', bytes: 4, cls: InstClass.LD, dst: 6, memBase: 5 }),
      mach({ op: Opcode.LDW, mnemonic: 'lw r5, 0(r5)', bytes: 4, cls: InstClass.LD, dst: 5, memBase: 5 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt r5', bytes: 4, cls: InstClass.NOP, srcA: 5 }),
    ]
    const out = simulate(hand(insts), hw(), mem)
    expect(out.result).toBe(8192)
    expect(out.dcMisses).toBe(1)
    expect(out.dcHits).toBe(1)
  })

  it('faults descriptively on empty RET and out-of-bounds CPU memory', () => {
    const ret = [mach({ op: Opcode.RET, mnemonic: 'ret', bytes: 4, cls: InstClass.BR })]
    expect(() => simulate(hand(ret), hw(), new ArrayBuffer(64))).toThrow(/RET with empty call stack/)
    const bad = [
      mach({ op: Opcode.LI, mnemonic: 'li r5, -1', bytes: 4, cls: InstClass.ALU, dst: 5, imm: -1 }),
      mach({ op: Opcode.LDW, mnemonic: 'lw', bytes: 4, cls: InstClass.LD, dst: 6, memBase: 5 }),
    ]
    expect(() => simulate(hand(bad), hw(), new ArrayBuffer(64))).toThrow(/CPU ldw.*address -1.*width 4/)
  })

  it('handles Power scaled word/double memory with large positive and negative offsets', () => {
    const word = run(`
      imm r0, 200000
      imm r1, 3
      imm r2, 123456
      stw r2, 70000(r0,r1,4)
      ldw r3, 70000(r0,r1,4)
      stw r3, -70000(r0,r1,4)
      ldw r4, -70000(r0,r1,4)
      halt r4
    `, {}, IsaId.POWER)
    expect(word.result).toBe(123456)

    const dbl = run(`
      imm r0, 200000
      imm r1, 3
      immf r2, 12.5
      std r2, 70000(r0,r1,8)
      ldd r3, 70000(r0,r1,8)
      std r3, -70000(r0,r1,8)
      ldd r4, -70000(r0,r1,8)
      halt r4
    `, {}, IsaId.POWER)
    expect(dbl.result).toBe(12.5)
  })

  it('completes a known program with inverse aggregate modeled-operation rates', () => {
    const m = run(`
      imm r0, 1
      imm r1, 2
      add r2, r0, r1
      halt r2
    `)
    expect(m.result).toBe(3)
    expect(m.instructions).toBeGreaterThan(0)
    expect(m.cycles).toBeGreaterThan(0)
    expect(m.cpi * m.ipc).toBeCloseTo(1, 10)
    expect(m.timeUs).toBeCloseTo(m.cycles / m.clockMhz, 10)
    expect(m.edp).toBeCloseTo(m.totalEnergyNj * m.timeUs, 8)
    expect(m.totalEnergyNj).toBeCloseTo(m.dynamicEnergyNj + m.staticEnergyNj, 8)
    const mixSum = Object.values(m.mix).reduce((a, b) => a + b, 0)
    expect(mixSum).toBe(m.instructions)
    expect(m.activeThreads).toBe(1)
  })

  it('issues two independent ALU ops in one cycle on a dual-issue machine', () => {
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'li x5, 1', bytes: 4, cls: InstClass.ALU, dst: 5, imm: 1 }),
      mach({ op: Opcode.LI, mnemonic: 'li x6, 2', bytes: 4, cls: InstClass.ALU, dst: 6, imm: 2 }),
      mach({ op: Opcode.ADD, mnemonic: 'add x7, x5, x6', bytes: 4, cls: InstClass.ALU, dst: 7, srcA: 5, srcB: 6 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt x7', bytes: 4, cls: InstClass.NOP, srcA: 7 }),
    ]
    const prog = hand(insts)
    const scalar = simulate(prog, hw({ issueWidth: 1, aluCount: 1, fetchWidth: 16 }), new ArrayBuffer(1 << 20))
    const dual = simulate(prog, hw({ issueWidth: 2, aluCount: 2, fetchWidth: 16 }), new ArrayBuffer(1 << 20))
    expect(scalar.result).toBe(3)
    expect(dual.result).toBe(3)
    expect(dual.cycles).toBeLessThan(scalar.cycles)
    expect(dual.ipc).toBeGreaterThan(scalar.ipc)
  })

  it('cannot pair a RAW-dependent consumer with its producer', () => {
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'li x5, 4', bytes: 4, cls: InstClass.ALU, dst: 5, imm: 4 }),
      mach({ op: Opcode.ADDI, mnemonic: 'addi x5, x5, 1', bytes: 4, cls: InstClass.ALU, dst: 5, srcA: 5, imm: 1 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt x5', bytes: 4, cls: InstClass.NOP, srcA: 5 }),
    ]
    const dual = simulate(
      hand(insts),
      hw({ issueWidth: 2, aluCount: 2, fetchWidth: 16 }),
      new ArrayBuffer(1 << 20),
    )
    expect(dual.result).toBe(5)
    expect(dual.cycles).toBeGreaterThanOrEqual(3)
  })

  it('charges MIPS an extra cycle before a load result is ready', () => {
    const src = `
      .data 4096
      .word 42
      .text
      imm r0, 4096
      ldw r1, 0(r0)
      add r2, r1, r1
      halt r2
    `
    const rv = run(src, {}, IsaId.RISCV)
    const mips = run(src, {}, IsaId.MIPS)
    expect(rv.result).toBe(84)
    expect(mips.result).toBe(84)
    expect(mips.cycles).toBeGreaterThan(rv.cycles)
  })

  it('charges SPARC a branch-delay cycle that RISC-V does not pay', () => {
    const src = `
      imm r0, 1
      br done
      imm r0, 99
      done:
      halt r0
    `
    const rv = run(src, {}, IsaId.RISCV)
    const sparc = run(src, {}, IsaId.SPARC)
    expect(rv.result).toBe(1)
    expect(sparc.result).toBe(1)
    expect(sparc.cycles).toBeGreaterThan(rv.cycles)
  })

  it('without forwarding, a producer’s result is not ready for several pipeline stages', () => {
    const src = `
      imm r0, 1
      addi r0, r0, 1
      halt r0
    `
    const fwd = run(src, { forwarding: true, pipelineStages: 5 })
    const stall = run(src, { forwarding: false, pipelineStages: 8 })
    expect(fwd.result).toBe(2)
    expect(stall.result).toBe(2)
    expect(stall.cycles).toBeGreaterThan(fwd.cycles)
  })

  it('does not train or count direct jumps as conditional predictions', () => {
    const src = `
      imm r0, 0
      imm r1, 24
      top:
        bge r0, r1, done
        addi r0, r0, 1
        br top
      done:
        halt r0
    `
    const none = run(src, { predictor: 'none', mispredictPenalty: 8, memLatency: 0 })
    const gshare = run(src, { predictor: 'gshare', predEntries: 64, mispredictPenalty: 8, memLatency: 0 })
    expect(none.result).toBe(24)
    expect(gshare.result).toBe(24)
    expect(gshare.mispredicts).toBe(none.mispredicts)
    expect(gshare.conditionalBranches).toBe(25)
    expect(gshare.directJumps).toBe(24)
    expect(gshare.branches).toBe(gshare.conditionalBranches)
  })

  it('a cold D-cache miss costs memLatency cycles versus a warm hit', () => {
    const src = `
      .data 4096
      .word 1 2 3 4
      .text
      imm r0, 4096
      ldw r1, 0(r0)
      ldw r2, 4(r0)
      add r3, r1, r2
      halt r3
    `
    const fast = run(src, { memLatency: 2, l1d: { sizeBytes: 32768, ways: 4, lineBytes: 64 } })
    const slow = run(src, { memLatency: 80, l1d: { sizeBytes: 32768, ways: 4, lineBytes: 64 } })
    expect(fast.result).toBe(3)
    expect(slow.result).toBe(3)
    expect(slow.cycles).toBeGreaterThan(fast.cycles)
    expect(fast.dcMisses).toBeGreaterThan(0)
    expect(fast.dcHits).toBeGreaterThan(0)
  })

  it('fetches every crossed line once without retry-hit inflation', () => {
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'crossing', bytes: 6, cls: InstClass.ALU, dst: 1, imm: 7 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 2, cls: InstClass.NOP, srcA: 1 }),
    ]
    const out = simulate(
      hand(insts),
      hw({
        fetchWidth: 16,
        complexDecodeBytes: 6,
        memLatency: 5,
        l1i: { sizeBytes: 64, ways: 1, lineBytes: 4 },
        l1d: { sizeBytes: 64, ways: 1, lineBytes: 4 },
        l2: { sizeBytes: 0, ways: 1, lineBytes: 4 },
        l3: { sizeBytes: 0, ways: 1, lineBytes: 4 },
      }),
      new ArrayBuffer(1 << 20),
    )
    expect(out.result).toBe(7)
    expect(out.icLineAccesses).toBe(3)
    expect(out.icMisses).toBe(2)
    expect(out.icHits).toBe(1)
    expect(out.fetchedBytes).toBe(8)
    expect(out.decodedBytes).toBe(8)

    const grouped = [
      mach({ op: Opcode.LI, mnemonic: 'a', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 1 }),
      mach({ op: Opcode.LI, mnemonic: 'b', bytes: 4, cls: InstClass.ALU, dst: 2, imm: 2 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP }),
    ]
    const groupedOut = simulate(
      hand(grouped),
      hw({
        issueWidth: 2,
        aluCount: 2,
        fetchWidth: 8,
        memLatency: 5,
        l1i: { sizeBytes: 64, ways: 1, lineBytes: 4 },
        l1d: { sizeBytes: 64, ways: 1, lineBytes: 4 },
        l2: { sizeBytes: 0, ways: 1, lineBytes: 4 },
        l3: { sizeBytes: 0, ways: 1, lineBytes: 4 },
      }),
      new ArrayBuffer(1 << 20),
    )
    expect(groupedOut.icLineAccesses).toBe(3)
    expect(groupedOut.icMisses).toBe(3)
    expect(groupedOut.fetchedBytes).toBe(12)
  })

  it('assembles oversized first operations across exact fetch-width cycles', () => {
    const source = 'imm r1, 4096\nimm r2, 0\nldd r0, 0(r1,r2,8)\nhalt r0'
    const compiled = compile(parseIr(source), IsaId.X86)
    expect(compiled.insts.some((inst) => inst.bytes === 9)).toBe(true)
    const width8 = run(source, { fetchWidth: 8 }, IsaId.X86)
    const width9 = run(source, { fetchWidth: 9 }, IsaId.X86)
    expect(width8.cycles - width9.cycles).toBe(1)
    expect(width8.fetchedBytes).toBe(width9.fetchedBytes)
    expect(width8.icLineAccesses).toBe(width9.icLineAccesses)

    const timing = (reverse: boolean, fetchWidth: number) => {
      const eight = mach({ op: Opcode.LI, mnemonic: 'eight', bytes: 8, cls: InstClass.ALU, dst: 1, imm: 1 })
      const nine = mach({ op: Opcode.LI, mnemonic: 'nine', bytes: 9, cls: InstClass.ALU, dst: 2, imm: 2 })
      const insts = reverse ? [nine, eight] : [eight, nine]
      insts.push(mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 1, cls: InstClass.NOP }))
      return simulate(
        hand(insts),
        hw({ fetchWidth, issueWidth: 2, aluCount: 2, complexDecodeBytes: 32 }),
        new ArrayBuffer(1 << 20),
      )
    }
    expect(timing(false, 8).cycles).toBe(timing(true, 8).cycles)
    expect(timing(true, 8).cycles - timing(true, 9).cycles).toBe(1)
  })

  it('accounts for crossed data lines and coalesces pending same-line misses', () => {
    const crossed = [
      mach({ op: Opcode.LI, mnemonic: 'address', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 63 }),
      mach({ op: Opcode.LDW, mnemonic: 'crossed load', bytes: 4, cls: InstClass.LD, dst: 2, memBase: 1 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP, srcA: 2 }),
    ]
    const crossedOut = simulate(
      hand(crossed),
      hw({ memLatency: 5, l1d: { sizeBytes: 256, ways: 1, lineBytes: 64 } }),
      new ArrayBuffer(1 << 20),
    )
    expect(crossedOut.dcLineAccesses).toBe(2)
    expect(crossedOut.dcMisses).toBe(2)

    const doubleCrossed = [
      mach({ op: Opcode.LI, mnemonic: 'address', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 60 }),
      mach({ op: Opcode.LDD, mnemonic: 'crossed double', bytes: 4, cls: InstClass.LD, dst: 2, memBase: 1 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP }),
    ]
    const doubleOut = simulate(
      hand(doubleCrossed),
      hw({ memLatency: 5, l1d: { sizeBytes: 256, ways: 1, lineBytes: 64 } }),
      new ArrayBuffer(1 << 20),
    )
    expect(doubleOut.dcLineAccesses).toBe(2)
    expect(doubleOut.dcMisses).toBe(2)

    const sameLine = [
      mach({ op: Opcode.LDW, mnemonic: 'load a', bytes: 4, cls: InstClass.LD, dst: 1 }),
      mach({ op: Opcode.LDW, mnemonic: 'load b', bytes: 4, cls: InstClass.LD, dst: 2 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP }),
    ]
    const coalesced = simulate(
      hand(sameLine),
      hw({ issueWidth: 2, memPorts: 2, fetchWidth: 16, memLatency: 7 }),
      new ArrayBuffer(1 << 20),
    )
    expect(coalesced.dcLineAccesses).toBe(2)
    expect(coalesced.dcMisses).toBe(1)
    // One data DRAM request plus the cold instruction line.
    expect(coalesced.dramRequests).toBe(2)
  })

  it('allows only one outstanding memory operation per thread within a wide group', () => {
    const mem = new ArrayBuffer(1 << 20)
    new DataView(mem).setInt32(0, 7, true)
    const insts = [
      mach({ op: Opcode.LDW, mnemonic: 'older load', bytes: 4, cls: InstClass.LD, dst: 1 }),
      mach({ op: Opcode.STW, mnemonic: 'younger store', bytes: 4, cls: InstClass.ST, srcA: 0 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP, srcA: 1 }),
    ]
    const out = simulate(
      hand(insts),
      hw({ issueWidth: 2, memPorts: 2, fetchWidth: 16, loadLatency: 4 }),
      mem,
    )
    expect(out.result).toBe(7)
    expect(new DataView(mem).getInt32(0, true)).toBe(0)
    expect(out.memoryOrderStallCycles).toBeGreaterThan(0)
  })

  it('respects multiply / divide latencies from the profile', () => {
    const src = `
      imm r0, 20
      imm r1, 3
      mul r2, r0, r1
      halt r2
    `
    const short = run(src, { mulLatency: 1 })
    const long = run(src, { mulLatency: 20 })
    expect(short.result).toBe(60)
    expect(long.result).toBe(60)
    expect(long.cycles).toBeGreaterThan(short.cycles)
  })

  it.each([
    ['mulLatency', Opcode.MUL, InstClass.MUL],
    ['divLatency', Opcode.DIV, InstClass.DIV],
    ['fpAddLatency', Opcode.ADDF, InstClass.FP],
    ['fpMulLatency', Opcode.MULF, InstClass.MUL],
    ['fpDivLatency', Opcode.DIVF, InstClass.DIV],
    ['loadLatency', Opcode.LDW, InstClass.LD],
  ] as const)('completes %s=1 exactly at the next cycle start', (field, op, cls) => {
    const operation = mach({
      op,
      mnemonic: field,
      bytes: 4,
      cls,
      dst: 1,
      srcA: 0,
      srcB: 0,
    })
    const out = simulate(
      hand([
        operation,
        mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP, srcA: 1 }),
      ]),
      hw({ [field]: 1 }),
      new ArrayBuffer(1 << 20),
    )
    expect(out.cycles).toBe(2)
    expect(out.completedOperations).toBe(2)
  })

  it('caps SPMD width by hardware threads and maxWorkers', () => {
    const src = `
      tid r0
      nthreads r1
      add r2, r0, r1
      halt r2
    `
    const m = run(src, { cores: 4, threads: 8 }, IsaId.RISCV)
    const program = compile(parseIr(src), IsaId.RISCV)
    const capped = simulate(program, hw({ cores: 4, threads: 8 }), new ArrayBuffer(1 << 20), {
      maxWorkers: 3,
    })
    expect(capped.activeThreads).toBe(3)
    expect(capped.busyCores).toBe(3)
    expect(capped.result).toBe(3)
    expect(m.activeThreads).toBeGreaterThan(1)
  })

  it('serializes same-cycle stores and transfers the remote-owned line', () => {
    const out = run(`
      tid r0
      imm r1, 4096
      stw r0, 0(r1)
      barrier
      ldw r2, 0(r1)
      halt r2
    `, { cores: 2, threads: 2, coherenceLatency: 3 }, IsaId.RISCV)
    expect(out.result).toBe(1)
    expect(out.coherenceTransfers).toBeGreaterThanOrEqual(1)
  })

  it('distinguishes false sharing from line-padded per-thread fields', () => {
    const sharing = (stride: number) => run(`
      tid r0
      imm r1, ${stride}
      mul r2, r0, r1
      imm r3, 4096
      add r4, r3, r2
      stw r0, 0(r4)
      barrier
      ldw r5, 0(r4)
      halt r5
    `, { cores: 4, threads: 4, coherenceLatency: 3 }, IsaId.RISCV)
    const falseShared = sharing(4)
    const padded = sharing(64)
    expect(falseShared.coherenceInvalidations).toBeGreaterThan(0)
    expect(falseShared.coherenceInvalidations).toBeGreaterThan(padded.coherenceInvalidations)
    expect(padded.coherenceInvalidations).toBe(0)
  })

  it('guards stale invalidations across projected competing ownership', () => {
    const out = run(`
      tid r0
      imm r1, 4096
      ldw r2, 0(r1)
      barrier
      stw r0, 0(r1)
      barrier
      ldw r3, 0(r1)
      halt r3
    `, { cores: 2, threads: 2, coherenceLatency: 3 }, IsaId.RISCV)
    expect(out.result).toBe(1)
    expect(out.dcMisses).toBe(3)
  })

  it('does not invalidate directory entries evicted from private caches', () => {
    const out = run(`
      tid r0
      imm r1, 4096
      imm r2, 4160
      imm r3, 0
      beq r0, r3, owner
      barrier
      barrier
      stw r0, 0(r1)
      halt r0
      owner:
      ldw r4, 0(r1)
      barrier
      ldw r5, 0(r2)
      barrier
      halt r5
    `, {
      cores: 2,
      threads: 2,
      coherenceLatency: 3,
      l1d: { sizeBytes: 64, ways: 1, lineBytes: 64 },
      l2: { sizeBytes: 0, ways: 1, lineBytes: 64 },
      l3: { sizeBytes: 0, ways: 1, lineBytes: 64 },
    }, IsaId.RISCV)
    expect(out.coherenceInvalidations).toBe(0)
  })

  it('uses the canonical line domain when private L1 caches are disabled', () => {
    const mem = new ArrayBuffer(1 << 20)
    const ir = parseIr(`
      tid r0
      imm r1, 4096
      ldw r2, 0(r1)
      barrier
      stw r0, 0(r1)
      halt r0
    `)
    const out = simulate(
      compile(ir, IsaId.RISCV),
      hw({
        cores: 2,
        threads: 2,
        coherenceLatency: 3,
        l1i: { sizeBytes: 0, ways: 1, lineBytes: 32 },
        l1d: { sizeBytes: 0, ways: 1, lineBytes: 32 },
        l2: { sizeBytes: 4096, ways: 4, lineBytes: 32 },
        l3: { sizeBytes: 8192, ways: 4, lineBytes: 32 },
      }),
      mem,
      { maxWorkers: 2 },
    )
    expect(new DataView(mem).getInt32(4096, true)).toBe(1)
    expect(out.coherenceInvalidations).toBeGreaterThan(0)
  })

  it('serial programs ignore extra cores', () => {
    const src = 'imm r0, 11\nhalt r0'
    const one = run(src, { cores: 1, threads: 1 })
    const many = run(src, { cores: 8, threads: 16 })
    expect(many.activeThreads).toBe(1)
    expect(many.result).toBe(11)
    expect(many.cycles).toBe(one.cycles)
  })

  it('commits at completion, enforces WAW, and drains unused work at HALT', () => {
    const waw = [
      mach({ op: Opcode.LI, mnemonic: 'old', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 1 }),
      mach({ op: Opcode.LI, mnemonic: 'new', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 2 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP, srcA: 1 }),
    ]
    const w = simulate(hand(waw), hw({ issueWidth: 4, aluCount: 4, fetchWidth: 32 }), new ArrayBuffer(1 << 20))
    expect(w.result).toBe(2)
    expect(w.cycles).toBe(3)
    expect(w.issuedOperations).toBe(3)
    expect(w.completedOperations).toBe(3)

    const unused = [
      mach({ op: Opcode.LDW, mnemonic: 'load', bytes: 4, cls: InstClass.LD, dst: 1 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP }),
    ]
    const u = simulate(hand(unused), hw({ loadLatency: 4 }), new ArrayBuffer(1 << 20))
    expect(u.cycles).toBe(5)
    expect(u.completedOperations).toBe(2)

    const storeMem = new ArrayBuffer(1 << 20)
    const store = [
      mach({ op: Opcode.LI, mnemonic: 'value', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 9 }),
      mach({ op: Opcode.STW, mnemonic: 'unused store', bytes: 4, cls: InstClass.ST, srcA: 1 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP }),
    ]
    const s = simulate(hand(store), hw(), storeMem)
    expect(s.cycles).toBe(3)
    expect(new DataView(storeMem).getInt32(0, true)).toBe(9)
  })

  it('orders store then load and drains a barrier', () => {
    const mem = new ArrayBuffer(1 << 20)
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'value', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 77 }),
      mach({ op: Opcode.STW, mnemonic: 'store', bytes: 4, cls: InstClass.ST, srcA: 1 }),
      mach({ op: Opcode.LDW, mnemonic: 'load', bytes: 4, cls: InstClass.LD, dst: 2 }),
      mach({ op: Opcode.BARRIER, mnemonic: 'barrier', bytes: 4, cls: InstClass.NOP, serializing: true }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP, srcA: 2 }),
    ]
    const out = simulate(hand(insts), hw({ loadLatency: 3, forwarding: false, pipelineStages: 5 }), mem)
    expect(out.result).toBe(77)
    expect(new DataView(mem).getInt32(0, true)).toBe(77)
    expect(out.completedOperations).toBe(out.issuedOperations)
    expect(out.memoryOrderStallCycles).toBeGreaterThan(0)
  })

  it('adds exactly P extra cycles for a conditional miss', () => {
    const src = `imm r0, 1
      imm r1, 1
      beq r0, r1, taken
      imm r2, 99
      taken: halt r0`
    const p0 = run(src, { predictor: 'none', mispredictPenalty: 0 })
    const p5 = run(src, { predictor: 'none', mispredictPenalty: 5 })
    expect(p0.mispredicts).toBe(1)
    expect(p5.mispredicts).toBe(1)
    expect(p5.cycles - p0.cycles).toBe(5)
  })

  it('counts calls, returns, indirect calls, and bounded RAS misses', () => {
    const source = `imm r0, 7
      call f
      la r2, g
      icall r2
      halt r0
      f: ret
      g: ret`
    const direct = run(source, { indirectCallPenalty: 4, rasDepth: 0 })
    expect(direct.calls).toBe(1)
    expect(direct.indirectCalls).toBe(1)
    expect(direct.returns).toBe(2)
    expect(direct.rasMisses).toBe(2)
    expect(direct.conditionalBranches).toBe(0)
    expect(direct.mispredicts).toBe(0)
    const noRedirect = run(source, { indirectCallPenalty: 0, rasDepth: 16 })
    const redirect = run(source, { indirectCallPenalty: 4, rasDepth: 16 })
    expect(redirect.cycles - noRedirect.cycles).toBe(4)
  })

  it('makes complex decode grouping order-independent and charges x86 decode', () => {
    const make = (reverse: boolean) => {
      const simple = mach({ op: Opcode.LI, mnemonic: 'simple', bytes: 3, cls: InstClass.ALU, dst: 1, imm: 1 })
      const complex = mach({ op: Opcode.LI, mnemonic: 'complex', bytes: 8, cls: InstClass.ALU, dst: 2, imm: 2 })
      return hand([
        ...(reverse ? [complex, simple] : [simple, complex]),
        mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 2, cls: InstClass.NOP }),
      ])
    }
    const profile = hw({ issueWidth: 4, aluCount: 4, fetchWidth: 32, complexDecodeBytes: 8 })
    expect(simulate(make(false), profile, new ArrayBuffer(1 << 20)).cycles)
      .toBe(simulate(make(true), profile, new ArrayBuffer(1 << 20)).cycles)
    const rv = simulate(make(false), profile, new ArrayBuffer(1 << 20))
    const x86 = simulate({ ...make(false), isa: IsaId.X86 }, profile, new ArrayBuffer(1 << 20))
    expect(x86.cycles).toBeGreaterThan(rv.cycles)
  })

  it('uses uops as deterministic issue capacity', () => {
    const insts = [
      mach({ op: Opcode.LI, mnemonic: 'three-uop', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 1, uops: 3 }),
      mach({ op: Opcode.LI, mnemonic: 'one-uop', bytes: 4, cls: InstClass.ALU, dst: 2, imm: 2 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP }),
    ]
    const out = simulate(hand(insts), hw({ issueWidth: 2, aluCount: 2, fetchWidth: 32 }), new ArrayBuffer(1 << 20))
    expect(out.issuedUops).toBe(5)
    expect(out.completedUops).toBe(5)
    expect(out.cycles).toBe(3)
  })

  it('defines exact load-to-use timing while allowing independent issue', () => {
    const insts = [
      mach({ op: Opcode.LDW, mnemonic: 'load', bytes: 4, cls: InstClass.LD, dst: 1 }),
      mach({ op: Opcode.LI, mnemonic: 'independent', bytes: 4, cls: InstClass.ALU, dst: 2, imm: 5 }),
      mach({ op: Opcode.ADD, mnemonic: 'use', bytes: 4, cls: InstClass.ALU, dst: 3, srcA: 1, srcB: 2 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP, srcA: 3 }),
    ]
    const profile = hw({ loadLatency: 3, issueWidth: 2, aluCount: 2, memPorts: 1, fetchWidth: 32 })
    const rv = simulate(hand(insts), profile, new ArrayBuffer(1 << 20))
    const mips = simulate(hand(insts, IsaId.MIPS), profile, new ArrayBuffer(1 << 20))
    expect(rv.cycles).toBe(5)
    expect(mips.cycles).toBe(6)
  })

  it('applies the SPARC control bubble to jump, call, return, and icall', () => {
    const src = `imm r0, 1
      br direct
      imm r0, 99
      direct: call f
      la r2, g
      icall r2
      halt r0
      f: ret
      g: ret`
    const rv = run(src, { indirectCallPenalty: 2 }, IsaId.RISCV)
    const sparc = run(src, { indirectCallPenalty: 2 }, IsaId.SPARC)
    expect(sparc.result).toBe(1)
    expect(sparc.directJumps).toBe(1)
    expect(sparc.calls).toBe(1)
    expect(sparc.indirectCalls).toBe(1)
    expect(sparc.returns).toBe(2)
    expect(sparc.cycles - rv.cycles).toBe(5)
  })

  it('scoreboards WASM stack/local and MOS carry/flags resources', () => {
    const wasm = [
      mach({ op: Opcode.NOP, mnemonic: 'local.get 0', bytes: 1, cls: InstClass.MOV,
        resourceReads: ['wasm.local.0', 'wasm.stack'], resourceWrites: ['wasm.stack'] }),
      mach({ op: Opcode.NOP, mnemonic: 'local.get 1', bytes: 1, cls: InstClass.MOV,
        resourceReads: ['wasm.local.1', 'wasm.stack'], resourceWrites: ['wasm.stack'] }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 1, cls: InstClass.NOP }),
    ]
    const mos = [
      mach({ op: Opcode.NOP, mnemonic: 'CLC', bytes: 1, cls: InstClass.ALU,
        resourceWrites: ['mos.carry'] }),
      mach({ op: Opcode.ADDI, mnemonic: 'ADC', bytes: 1, cls: InstClass.ALU, dst: 0, srcA: 0,
        resourceReads: ['mos.carry'], resourceWrites: ['mos.carry', 'mos.flags'] }),
      mach({ op: Opcode.BEQ, mnemonic: 'BEQ', bytes: 1, cls: InstClass.BR, srcA: 0, srcB: 0,
        resourceReads: ['mos.flags'] }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 1, cls: InstClass.NOP }),
    ]
    mos[2].target = 3
    const wide = hw({ issueWidth: 4, aluCount: 4, fetchWidth: 32, complexDecodeBytes: 8 })
    expect(simulate(hand(wasm, IsaId.WASM), wide, new ArrayBuffer(1 << 20)).cycles).toBe(3)
    expect(simulate(hand(mos, IsaId.MOS), wide, new ArrayBuffer(1 << 20)).cycles).toBe(4)
  })

  it('defines aggregate rates, origins, skipped stalls, and core residency exactly', () => {
    const serial = run(
      `imm r0, 1
       addi r1, r0, 1
       halt r1`,
      { cores: 4, threads: 4, memLatency: 7 },
    )
    expect(serial.aggregateModeledOpsPerCycle).toBe(serial.completedOperations / serial.cycles)
    expect(serial.modelCyclesPerAggregateOp).toBe(serial.cycles / serial.completedOperations)
    expect(serial.ipc).toBe(serial.aggregateModeledOpsPerCycle)
    expect(serial.cpi).toBe(serial.modelCyclesPerAggregateOp)
    expect(Object.values(serial.operationOrigins).reduce((a, b) => a + b, 0))
      .toBe(serial.completedOperations)
    expect(serial.issuedOperations).toBe(serial.completedOperations)
    expect(serial.issuedUops).toBe(serial.completedUops)
    expect(serial.activeCoreCycles + serial.stalledCoreCycles + serial.idleCoreCycles)
      .toBe(serial.cycles * 4)
    expect(serial.coresThatIssued).toBe(1)
    expect(serial.busyCores).toBe(serial.coresThatIssued)

    const parallel = run(
      `nthreads r0
       tid r1
       add r2, r0, r1
       halt r2`,
      { cores: 4, threads: 4, issueWidth: 1, aluCount: 1 },
    )
    expect(parallel.activeThreads).toBe(4)
    expect(parallel.coresThatIssued).toBe(4)
    expect(parallel.completedOperations).toBeGreaterThan(serial.completedOperations)
    expect(parallel.operationOrigins.runtime).toBeGreaterThan(0)
    expect(parallel.activeCoreCycles + parallel.stalledCoreCycles + parallel.idleCoreCycles)
      .toBe(parallel.cycles * 4)

    const delayed = run(
      `imm r0, 6
       imm r1, 7
       mul r2, r0, r1
       add r3, r2, r0
       halt r3`,
      { mulLatency: 9 },
    )
    const causes = delayed.dependencyStallCycles + delayed.fetchStallCycles +
      delayed.resourceStallCycles + delayed.memoryOrderStallCycles +
      delayed.serializationStallCycles
    expect(delayed.zeroIssueCycles).toBeGreaterThan(1)
    expect(delayed.stalls).toBe(delayed.zeroIssueCycles)
    expect(causes).toBe(delayed.zeroIssueCycles)
  })

  it('charges only dynamically decoded code, never unreachable footprint', () => {
    const baseInsts = [
      mach({ op: Opcode.LI, mnemonic: 'value', bytes: 4, cls: InstClass.ALU, dst: 1, imm: 7 }),
      mach({ op: Opcode.HALT, mnemonic: 'halt', bytes: 4, cls: InstClass.NOP, srcA: 1 }),
    ]
    const base = simulate(hand(baseInsts), hw(), new ArrayBuffer(1 << 20))
    const extended = simulate(hand([
      ...baseInsts.map((inst) => ({ ...inst })),
      mach({ op: Opcode.DIV, mnemonic: 'dead div', bytes: 64, cls: InstClass.DIV, dst: 2 }),
    ]), hw(), new ArrayBuffer(1 << 20))
    expect(extended.codeBytes).toBeGreaterThan(base.codeBytes)
    expect(extended.decodedBytes).toBe(base.decodedBytes)
    expect(extended.dynamicEnergyNj).toBe(base.dynamicEnergyNj)

    const loop = (limit: number) => run(
      `imm r0, 0
       imm r1, ${limit}
       imm r2, 1
       loop: add r0, r0, r2
       blt r0, r1, loop
       halt r0`,
    )
    const short = loop(2)
    const long = loop(5)
    expect(long.decodedBytes).toBeGreaterThan(short.decodedBytes)
    expect(long.operationDecodeEnergyNj).toBeGreaterThan(short.operationDecodeEnergyNj)
  })

  it('reports compiled semantic, lowering, and runtime origins at completion', () => {
    const source = `imm r0, 5
      imm r1, 7
      add r2, r0, r1
      halt r2`
    for (const isa of ALL_ISAS) {
      const ir = parseIr(source)
      const program = compile(ir, isa)
      const expected = { semantic: 0, lowering: 0, runtime: 0 }
      for (const inst of program.insts) expected[inst.origin] += 1
      const out = simulate(program, hw(), new ArrayBuffer(1 << 20))
      expect(out.operationOrigins, isa).toEqual(expected)
      expect(Object.values(out.operationOrigins).reduce((a, b) => a + b, 0), isa)
        .toBe(out.completedOperations)
      expect(out.operationOrigins.semantic, isa).toBeGreaterThan(0)
      expect(out.operationOrigins.runtime, isa).toBeGreaterThan(0)
      if (isa === IsaId.X86 || isa === IsaId.WASM || isa === IsaId.MOS) {
        expect(out.operationOrigins.lowering, isa).toBeGreaterThan(0)
      }
    }
  })
})
