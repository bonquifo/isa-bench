import { parseC } from './cparse.ts'
import { lowerC, type CLowered } from './clower.ts'

export const GUEST_C_VERSION = 'Guest C v1.4' as const

export { CError } from './clex.ts'
export {
  C_EXAMPLES,
  SAMPLE_C,
  cExampleByWorkloadId,
  cWorkloadId,
  isCWorkload,
  type CExample,
} from './programs.ts'

export function compileC(source: string): CLowered {
  return lowerC(parseC(source))
}
