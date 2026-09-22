/**
 * x86-64 binding for the shared fixture reader: where the fixtures live and
 * how to name the fields of this architecture's state dump.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { X86_DUMP_BYTES } from './backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const X86_FIXTURE_DIR = join(HERE, 'fixtures')

const SCRATCH_OFFSET = 400

const GPR_NAMES = [
  'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
]

/** Mirrors struct IsaDump in tools/isa/x86/harness.h. */
export function labelX86Dump(bytes: Uint8Array): Map<number, string> {
  const labels = new Map<number, string>()
  for (let i = 0; i < 16; i++) labels.set(i * 8, GPR_NAMES[i]!)
  labels.set(128, 'rflags')
  labels.set(136, 'pad')
  for (let i = 0; i < 16; i++) {
    labels.set(144 + i * 16, `xmm${i}.low`)
    labels.set(144 + i * 16 + 8, `xmm${i}.high`)
  }
  for (let i = SCRATCH_OFFSET; i < bytes.length; i += 8) {
    labels.set(i, `scratch[${(i - SCRATCH_OFFSET) / 8}]`)
  }
  return labels
}

export { X86_DUMP_BYTES }
