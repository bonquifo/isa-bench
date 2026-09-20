import { parseC } from './cparse.ts';
import { lowerC } from './clower.ts';
export const GUEST_C_VERSION = 'Guest C v1.4';
export { CError } from './clex.ts';
export { C_EXAMPLES, SAMPLE_C, cExampleByWorkloadId, cWorkloadId, isCWorkload, } from './programs.ts';
export function compileC(source) {
    return lowerC(parseC(source));
}
//# sourceMappingURL=compile_c.js.map