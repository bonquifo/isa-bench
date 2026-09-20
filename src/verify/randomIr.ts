export type RandomIrKind = 'straight-line' | 'controlled-branch' | 'memory'

export interface RandomIrProgram {
  seed: number
  kind: RandomIrKind
  source: string
  expectedReturn: number
  expectedStdout: ''
}

function next(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) | 0
}

/** Produces a small, bounded program with an independent signed-i32 oracle. */
export function generateRandomIr(seed: number): RandomIrProgram {
  const normalizedSeed = seed | 0
  let state = normalizedSeed
  const draw = (): number => {
    state = next(state)
    return state
  }
  const kindIndex = (draw() >>> 0) % 3

  if (kindIndex === 0) {
    const a = (draw() % 2001) - 1000
    const b = (draw() % 101) - 50
    const shift = (draw() >>> 0) % 8
    const sum = (a + b) | 0
    const product = Math.imul(sum, b)
    const expectedReturn = (product ^ (product << shift)) | 0
    return {
      seed: normalizedSeed,
      kind: 'straight-line',
      expectedReturn,
      expectedStdout: '',
      source: [
        `imm r0, ${a}`,
        `imm r1, ${b}`,
        'add r2, r0, r1',
        'mul r3, r2, r1',
        `imm r4, ${shift}`,
        'shl r5, r3, r4',
        'xor r6, r3, r5',
        'halt r6',
      ].join('\n'),
    }
  }

  if (kindIndex === 1) {
    const iterations = 2 + ((draw() >>> 0) % 7)
    const initial = (draw() % 401) - 200
    const delta = (draw() % 19) - 9
    let expectedReturn = initial | 0
    for (let i = 0; i < iterations; i++) expectedReturn = ((expectedReturn ^ i) + delta) | 0
    return {
      seed: normalizedSeed,
      kind: 'controlled-branch',
      expectedReturn,
      expectedStdout: '',
      source: [
        'imm r0, 0',
        `imm r1, ${iterations}`,
        `imm r2, ${initial}`,
        'loop:',
        'bge r0, r1, done',
        'xor r2, r2, r0',
        `addi r2, r2, ${delta}`,
        'addi r0, r0, 1',
        'br loop',
        'done:',
        'halt r2',
      ].join('\n'),
    }
  }

  const words = [draw() | 0, draw() | 0, draw() | 0, draw() | 0]
  const index = (draw() >>> 0) % words.length
  const addend = (draw() % 31) - 15
  const expectedReturn = (words[index] + addend) | 0
  return {
    seed: normalizedSeed,
    kind: 'memory',
    expectedReturn,
    expectedStdout: '',
    source: [
      '.data 4096',
      `.word ${words.join(' ')}`,
      '.text',
      'imm r0, 4096',
      `imm r1, ${index}`,
      'ldw r2, 0(r0,r1,4)',
      `addi r3, r2, ${addend}`,
      'stw r3, 0(r0,r1,4)',
      'ldw r4, 0(r0,r1,4)',
      'halt r4',
    ].join('\n'),
  }
}
