import { describe, expect, it } from 'vitest'
import {
  compareResultFrame,
  encodeResultFrame,
  frameValue,
  parseResultFrame,
  type ResultFrame,
} from './resultFrame.ts'

describe('target-neutral result frame', () => {
  it('round-trips i32 result and byte-exact stdout', () => {
    const frame: ResultFrame = {
      version: 1,
      status: 'ok',
      resultKind: 'i32',
      rawBits: 0xffff_ffffn,
      stdout: new TextEncoder().encode('ok\0'),
      fault: '',
    }
    const parsed = parseResultFrame(encodeResultFrame(frame))
    expect(frameValue(parsed)).toBe(-1)
    expect(compareResultFrame(parsed, { value: -1, stdout: 'ok\0' })).toEqual({
      equal: true,
      reason: 'result and stdout match independent reference',
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0])(
    'preserves binary64 raw bits for %s',
    (value) => {
      const bytes = new Uint8Array(8)
      const view = new DataView(bytes.buffer)
      view.setFloat64(0, value, true)
      const frame: ResultFrame = {
        version: 1,
        status: 'ok',
        resultKind: 'binary64',
        rawBits: view.getBigUint64(0, true),
        stdout: new Uint8Array(),
        fault: '',
      }
      expect(compareResultFrame(parseResultFrame(encodeResultFrame(frame)), { value, stdout: '' }).equal).toBe(true)
    },
  )

  it('rejects malformed and oversized frames', () => {
    expect(() => parseResultFrame(new Uint8Array(24))).toThrow('magic')
    const valid = encodeResultFrame({
      version: 1,
      status: 'fault',
      resultKind: 'i32',
      rawBits: 0n,
      stdout: new Uint8Array(),
      fault: 'bounds',
    })
    expect(() => parseResultFrame(valid, 2)).toThrow('exceeds')
  })
})
