import { describe, expect, it } from 'vitest'
import { LANES, nextLaneIndex, nextRovingIndex } from './types.ts'

describe('model lane navigation', () => {
  it('exposes each timing model as its own navigation destination', () => {
    expect(LANES.map((lane) => lane.id)).toEqual(['inorder', 'ooo'])
    expect(LANES.map((lane) => lane.runLabel)).toEqual(['RUN MODEL', 'RUN MODEL'])
    expect(LANES.every((lane) => lane.category === 'MODEL')).toBe(true)
  })

  it('wraps roving tabindex movement at both ends', () => {
    expect(nextLaneIndex('Home', 1)).toBe(0)
    expect(nextLaneIndex('End', 0)).toBe(1)
    expect(nextLaneIndex('ArrowRight', 1)).toBe(0)
    expect(nextLaneIndex('ArrowLeft', 0)).toBe(1)
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
