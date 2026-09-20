import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseIr } from '../../src/engine/ir.ts'
import { emitCanonicalLlvmIr, LLVM_EMITTER_VERSION } from '../../src/toolchains/llvmEmitter.ts'

const program = parseIr([
  '.data 4096',
  '.word 287454020',
  '.double -0',
  '.text',
  'imm r0, 4097',
  'ldw r1, 0(r0)',
  'imm r2, 40',
  'shl r3, r1, r2',
  'call adjust',
  'halt r3',
  'adjust:',
  'imm r4, -1',
  'div r5, r3, r4',
  'ret',
].join('\n'))
const directory = resolve('.isa-bench-data/toolchain-smoke')
mkdirSync(directory, { recursive: true })
writeFileSync(resolve(directory, 'canonical.ll'), emitCanonicalLlvmIr(program))
writeFileSync(resolve(directory, 'canonical.metadata.json'), `${JSON.stringify({
  emitterVersion: LLVM_EMITTER_VERSION,
  memoryBytes: program.memSize,
  expectedI32: 0x11223300,
}, null, 2)}\n`)
