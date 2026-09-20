import { describe, expect, it } from 'vitest'
import { readGuestStdout } from './guestio.ts'
import { MEM_SIZE, STDOUT_BASE, STDOUT_MAX } from './types.ts'

function memWithStdout(chars: string, n = chars.length): ArrayBuffer {
  const mem = new ArrayBuffer(MEM_SIZE)
  const view = new DataView(mem)
  view.setInt32(STDOUT_BASE, n, true)
  for (let i = 0; i < chars.length; i++) {
    view.setInt32(STDOUT_BASE + 4 + i * 4, chars.charCodeAt(i), true)
  }
  return mem
}

describe('guest stdout capture', () => {
  it('reads a word-per-character buffer as a JS string', () => {
    expect(readGuestStdout(memWithStdout('hi\n'))).toBe('hi\n')
  })

  it('returns empty for n ≤ 0 or n above the cap', () => {
    expect(readGuestStdout(memWithStdout('', 0))).toBe('')
    expect(readGuestStdout(memWithStdout('', -3))).toBe('')
    expect(readGuestStdout(memWithStdout('x', STDOUT_MAX + 1))).toBe('')
  })

  it('masks stored words to 8-bit characters', () => {
    const mem = memWithStdout('A')
    new DataView(mem).setInt32(STDOUT_BASE + 4, 0x141, true)
    expect(readGuestStdout(mem)).toBe('A')
  })

  it('accepts a buffer filled to STDOUT_MAX', () => {
    const chars = 'a'.repeat(STDOUT_MAX)
    expect(readGuestStdout(memWithStdout(chars))).toBe(chars)
  })
})
