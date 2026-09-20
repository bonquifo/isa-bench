import { type IrInst } from './ir.ts';
import { type MachInst } from './types.ts';
export interface Emitter {
    label(name: string): void;
    push(m: MachInst): void;
    action(ins: IrInst, emit: () => void): void;
    scratch(avoid: number[]): number;
}
export declare function emitThread(e: Emitter, ins: IrInst, name: (r: number) => string): boolean;
export declare function lowerPower(ir: IrInst[], e: Emitter): void;
export declare function lowerSparc(ir: IrInst[], e: Emitter): void;
export declare function lowerWasm(ir: IrInst[], e: Emitter): void;
export declare function lowerMos(ir: IrInst[], e: Emitter): void;
//# sourceMappingURL=lower_extra.d.ts.map