import { isSafePowerOfTwo } from './bits.ts';
export class BranchPredictor {
    kind;
    mask;
    table;
    ghr = 0;
    constructor(hw) {
        this.kind = hw.predictor;
        const n = hw.predEntries;
        if (!isSafePowerOfTwo(n)) {
            throw new Error(`Predictor entries must be a positive safe power of two (got ${n})`);
        }
        this.mask = n - 1;
        this.table = new Uint8Array(n);
        this.table.fill(1);
    }
    predict(addr, target) {
        switch (this.kind) {
            case 'none':
                return false;
            case 'static':
                return target < addr;
            case 'bimodal':
                return this.table[this.index(addr)] >= 2;
            case 'gshare':
                return this.table[this.gshare(addr)] >= 2;
        }
    }
    update(addr, taken) {
        if (this.kind === 'none' || this.kind === 'static')
            return;
        const idx = this.kind === 'gshare' ? this.gshare(addr) : this.index(addr);
        const cur = this.table[idx];
        if (taken && cur < 3)
            this.table[idx] = cur + 1;
        if (!taken && cur > 0)
            this.table[idx] = cur - 1;
        this.ghr = ((this.ghr << 1) | (taken ? 1 : 0)) & this.mask;
    }
    index(addr) {
        return (addr >>> 2) & this.mask;
    }
    gshare(addr) {
        return ((addr >>> 2) ^ this.ghr) & this.mask;
    }
}
//# sourceMappingURL=predictor.js.map