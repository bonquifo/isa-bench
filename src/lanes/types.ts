export type LaneId = 'inorder' | 'ooo'

export const LANES: ReadonlyArray<{
  id: LaneId
  title: string
  short: string
  category: 'MODEL'
  runLabel: string
  runHint: string
}> = [
  {
    id: 'inorder',
    title: 'In-order Model',
    short: 'IN-ORDER',
    category: 'MODEL',
    runLabel: 'RUN MODEL',
    runHint: 'Use RUN MODEL in the top cyan/magenta bar. Runs the deterministic in-order timing model across every selected ISA.',
  },
  {
    id: 'ooo',
    title: 'Detailed Out-of-order Model',
    short: 'DETAILED OOO',
    category: 'MODEL',
    runLabel: 'RUN MODEL',
    runHint: 'Use RUN MODEL in the top cyan/magenta bar. This is the decoded-operation out-of-order model, not the in-order model.',
  },
]

export function nextLaneIndex(key: string, index: number): number {
  return nextRovingIndex(key, index, LANES.length)
}

/** Roving tabindex arrow/Home/End handling; -1 means the key is not a move. */
export function nextRovingIndex(key: string, index: number, length: number): number {
  if (!Number.isSafeInteger(length) || length < 1) return -1
  const last = length - 1
  if (key === 'Home') return 0
  if (key === 'End') return last
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % length
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index + last) % length
  return -1
}
