import { describe, expect, it } from 'vitest'
import { LANES, nextLaneIndex, nextRovingIndex } from './types.ts'

describe('model lane navigation', () => {
  it('exposes each timing model as its own navigation destination', () => {
    expect(LANES.map((lane) => lane.id)).toEqual(['inorder', 'ooo', 'realisa'])
    expect(LANES.every((lane) => lane.runLabel === 'RUN MODEL')).toBe(true)
    // The real-ISA lane is categorised apart from the two modelling lanes on
    // purpose: it executes instructions a compiler emitted rather than a
    // lowering the engine invents, and that shows before any number does.
    expect(LANES.map((lane) => lane.category))
      .toEqual(['MODEL', 'MODEL', 'EXECUTION + MODEL'])
  })

  it('wraps roving tabindex movement at both ends', () => {
    // Expressed against the lane count so that adding a lane does not need
    // this rewritten, only reconsidered.
    const last = LANES.length - 1
    expect(nextLaneIndex('Home', last)).toBe(0)
    expect(nextLaneIndex('End', 0)).toBe(last)
    expect(nextLaneIndex('ArrowRight', last)).toBe(0)
    expect(nextLaneIndex('ArrowLeft', 0)).toBe(last)
    expect(nextLaneIndex('Enter', 0)).toBe(-1)
  })

  it('handles arbitrary list lengths and rejects invalid ones', () => {
    expect(nextRovingIndex('ArrowRight', 6, 7)).toBe(0)
    expect(nextRovingIndex('ArrowLeft', 0, 7)).toBe(6)
    expect(nextRovingIndex('Home', 5, 7)).toBe(0)
    expect(nextRovingIndex('End', 0, 7)).toBe(6)
    expect(nextRovingIndex('ArrowDown', 0, 0)).toBe(-1)
  })
})
