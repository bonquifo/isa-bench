import type { HardwareProfile } from './types.ts';
export declare class BranchPredictor {
    private readonly kind;
    private readonly mask;
    private readonly table;
    private ghr;
    constructor(hw: HardwareProfile);
    predict(addr: number, target: number): boolean;
    update(addr: number, taken: boolean): void;
    private index;
    private gshare;
}
//# sourceMappingURL=predictor.d.ts.map