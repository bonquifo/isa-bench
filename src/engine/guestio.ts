import { STDOUT_BASE, STDOUT_MAX } from './types.ts'

export function readGuestStdout(mem: ArrayBuffer): string {
  if (STDOUT_BASE > mem.byteLength - 4) return ''
  const view = new DataView(mem)
  const n = view.getInt32(STDOUT_BASE, true)
  if (n <= 0 || n > STDOUT_MAX) return ''
  if (STDOUT_BASE + 4 + n * 4 > mem.byteLength) return ''
  const chars: number[] = []
  for (let i = 0; i < n; i++) {
    chars.push(view.getInt32(STDOUT_BASE + 4 + i * 4, true) & 0xff)
  }
  return String.fromCharCode(...chars)
}
