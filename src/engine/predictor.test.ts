import { describe, expect, it } from 'vitest'
import { profileById } from './hardware.ts'
import { BranchPredictor } from './predictor.ts'
import type { HardwareProfile } from './types.ts'

function pred(kind: HardwareProfile['predictor'], entries = 16): BranchPredictor {
  const hw = profileById('equal-inorder')
  return new BranchPredictor({ ...hw, predictor: kind, predEntries: entries })
}

describe('branch predictors', () => {
  it('rejects non-power-of-two table sizes', () => {
    expect(() => pred('gshare', 0)).toThrow(/power of two/)
    expect(() => pred('bimodal', 12)).toThrow(/power of two/)
    expect(() => pred('bimodal', 4294967297)).toThrow(/safe power of two/)
  })

  it('never predicts taken when the predictor is disabled', () => {
    const p = pred('none')
    expect(p.predict(0x100, 0x80)).toBe(false)
    expect(p.predict(0x100, 0x200)).toBe(false)
    p.update(0x100, true)
    expect(p.predict(0x100, 0x80)).toBe(false)
  })

  it('uses the static BTFN heuristic: backward taken, forward not taken', () => {
    const p = pred('static')
    expect(p.predict(0x200, 0x100)).toBe(true)
    expect(p.predict(0x100, 0x200)).toBe(false)
    expect(p.predict(0x100, 0x100)).toBe(false)
    p.update(0x200, false)
    expect(p.predict(0x200, 0x100)).toBe(true)
  })

  it('starts a 2-bit bimodal counter in the weakly-not-taken state', () => {
    const p = pred('bimodal', 16)
    const pc = 0x40
    expect(p.predict(pc, 0)).toBe(false)
    p.update(pc, true)
    expect(p.predict(pc, 0)).toBe(true)
    p.update(pc, true)
    p.update(pc, true)
    expect(p.predict(pc, 0)).toBe(true)
    p.update(pc, false)
    expect(p.predict(pc, 0)).toBe(true)
    p.update(pc, false)
    expect(p.predict(pc, 0)).toBe(false)
  })

  it('saturates the 2-bit counter at 0 and 3', () => {
    const p = pred('bimodal', 8)
    const pc = 0
    for (let i = 0; i < 8; i++) p.update(pc, false)
    expect(p.predict(pc, 0)).toBe(false)
    p.update(pc, true)
    expect(p.predict(pc, 0)).toBe(false)
    p.update(pc, true)
    expect(p.predict(pc, 0)).toBe(true)
  })

  it('indexes bimodal by PC>>2 so same-word aliases share a counter', () => {
    const p = pred('bimodal', 8)
    p.update(0x20, true)
    p.update(0x20, true)
    expect(p.predict(0x20, 0)).toBe(true)
    expect(p.predict(0x21, 0)).toBe(true)
    expect(p.predict(0x24, 0)).toBe(false)
  })

  it('hashes gshare with PC XOR global history', () => {
    const a = pred('gshare', 16)
    const b = pred('gshare', 16)
    const pc = 0x80
    a.update(0x10, true)
    a.update(0x14, false)
    a.update(0x18, true)
    expect(a.predict(pc, 0)).toBe(false)
    for (let i = 0; i < 4; i++) {
      a.update(pc, true)
      b.update(pc, true)
    }
    expect(a.predict(pc, 0)).not.toBe(b.predict(pc, 0))
  })

  it('learns a tight taken loop with gshare', () => {
    const p = pred('gshare', 64)
    const pc = 0x100
    let takenPreds = 0
    for (let i = 0; i < 32; i++) {
      if (p.predict(pc, 0x80)) takenPreds += 1
      p.update(pc, true)
    }
    expect(p.predict(pc, 0x80)).toBe(true)
    expect(takenPreds).toBeGreaterThan(20)
  })
})
