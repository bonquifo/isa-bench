import { type IrProgram } from '../ir.ts';
import { type CProgram } from './cparse.ts';
export interface CLowered {
    ir: IrProgram;
    guestVersion: 'Guest C v1.4';
    notes: string;
}
export declare function lowerC(prog: CProgram): CLowered;
//# sourceMappingURL=clower.d.ts.map