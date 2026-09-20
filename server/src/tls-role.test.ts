import { describe, expect, it } from 'vitest'
import { certificateRole } from './tls-role.js'

describe('mTLS role separation', () => {
  it('never maps one certificate to both admin and runner', () => {
    const admin = 'a'.repeat(64)
    const runner = 'b'.repeat(64)
    expect(certificateRole(admin, [admin], runner)).toBe('admin')
    expect(certificateRole(runner, [admin], runner)).toBe('runner')
    expect(certificateRole(admin, [admin], admin)).toBe('conflict')
    expect(certificateRole('c'.repeat(64), [admin], runner)).toBe('none')
  })
})
