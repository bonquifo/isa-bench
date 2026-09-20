import { IsaId } from './types.ts';
import { type IrInst } from './ir.ts';
export interface Allocation {
    map: Map<number, number>;
    spills: Map<number, number>;
    scratches: number[];
    sp: number;
    stackSlots: number;
    physUsed: Set<number>;
    callSaves: Map<number, number[]>;
    callSpillSaves: Map<number, number[]>;
}
export interface IsaRegs {
    allocatable: number[];
    scratches: number[];
    sp: number;
}
export declare function isaRegs(isa: IsaId): IsaRegs;
export declare function allocate(insts: IrInst[], isa: IsaId): Allocation;
export declare function legalize(insts: IrInst[], alloc: Allocation): IrInst[];
//# sourceMappingURL=regalloc.d.ts.map